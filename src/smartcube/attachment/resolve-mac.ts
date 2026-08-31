import type { AttachmentContext } from './types';
import type { MacAddressProvider } from '../types';
import { getCachedMacForDevice, waitForManufacturerData } from './address-hints';
import { throwIfAborted } from './abort';

export type ResolveCubeMacOptions = {
    /** Parse a MAC from advertisement manufacturer data (context-supplied or freshly awaited). */
    parseFromManufacturerData: (mf: BluetoothManufacturerData | DataView | null) => string | null;
    /** Advertisement wait budget in ms: [normal, with enableAddressSearch]. */
    advertisementTimeoutsMs: [number, number];
    /** Candidate addresses derived from the advertised name. */
    candidatesFromName?: (name: string | undefined) => string[];
    /** Use a single name-derived candidate directly, without probing (QiYi patterns are unambiguous). */
    useSingleCandidateWithoutProbe?: boolean;
    /** Cryptographic probe validating one candidate against live traffic. */
    probe?: (
        device: BluetoothDevice,
        mac: string,
        options: { timeoutMs: number; signal?: AbortSignal }
    ) => Promise<boolean>;
    probeTimeoutMs?: number;
};

/**
 * The MAC-resolution ladder shared by drivers that must learn the cube's address:
 * advertisement context -> cached MAC -> provider -> fresh advertisements (merged frames) ->
 * name-derived candidates (optionally probed) -> provider fallback. Returns null when exhausted.
 */
export async function resolveCubeMac(
    device: BluetoothDevice,
    macProvider: MacAddressProvider | undefined,
    context: AttachmentContext | undefined,
    options: ResolveCubeMacOptions
): Promise<string | null> {
    let mac = options.parseFromManufacturerData(context?.advertisementManufacturerData ?? null);
    mac = mac || getCachedMacForDevice(device);
    if (!mac && macProvider) {
        const r = await macProvider(device, false);
        if (r) {
            mac = r;
        }
    }

    if (!mac) {
        // The first advertisement frequently carries no manufacturer data; merge frames until one does.
        const mfData = await waitForManufacturerData(
            device,
            context?.enableAddressSearch ? options.advertisementTimeoutsMs[1] : options.advertisementTimeoutsMs[0],
            { earlyExitOnEmptyFirstAdvertisement: false, signal: context?.signal }
        );
        mac = options.parseFromManufacturerData(mfData);
    }

    if (!mac && options.useSingleCandidateWithoutProbe && options.candidatesFromName) {
        const candidates = options.candidatesFromName(device.name);
        if (candidates.length === 1) {
            mac = candidates[0]!;
        }
    }

    if (!mac && context?.enableAddressSearch && options.candidatesFromName && options.probe) {
        const candidates = options.candidatesFromName(device.name);
        for (let i = 0; i < candidates.length; i++) {
            if (context.signal?.aborted) {
                break;
            }
            context.onStatus?.(`Testing address (${i + 1}/${candidates.length})…`);
            try {
                if (
                    await options.probe(device, candidates[i]!, {
                        timeoutMs: options.probeTimeoutMs ?? 2000,
                        signal: context.signal,
                    })
                ) {
                    mac = candidates[i]!;
                    break;
                }
            } catch {
                /* try next */
            }
        }
    }

    if (!mac && macProvider) {
        const r = await macProvider(device, true);
        if (r) {
            mac = r;
        }
    }

    throwIfAborted(context?.signal);
    return mac;
}
