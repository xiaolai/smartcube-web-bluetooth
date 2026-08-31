import type { AttachmentContext } from './types';
import type { MacAddressProvider } from '../types';
import { getCachedMacForDevice, removeCachedMacForDevice, waitForManufacturerData } from './address-hints';
import { isAbortError, throwIfAborted } from './abort';
import { parseMacBytes } from './mac-address';

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

/** A malformed cached value would reach key derivation and fail every connect: drop it. */
function validCachedMac(device: BluetoothDevice): string | null {
    const cached = getCachedMacForDevice(device);
    if (!cached) {
        return null;
    }
    try {
        parseMacBytes(cached);
        return cached;
    } catch {
        removeCachedMacForDevice(device);
        return null;
    }
}

/**
 * The MAC-resolution ladder shared by drivers that must learn the cube's address:
 * advertisement context -> cached MAC (validated) -> provider -> fresh advertisements
 * (merged frames) -> name-derived candidates (optionally probed) -> provider fallback.
 * Returns null when exhausted.
 */
export async function resolveCubeMac(
    device: BluetoothDevice,
    macProvider: MacAddressProvider | undefined,
    context: AttachmentContext | undefined,
    options: ResolveCubeMacOptions
): Promise<string | null> {
    throwIfAborted(context?.signal);
    let mac = options.parseFromManufacturerData(context?.advertisementManufacturerData ?? null);
    mac = mac || validCachedMac(device);
    if (!mac && macProvider) {
        const r = await macProvider(device, false);
        throwIfAborted(context?.signal);
        if (r) {
            mac = r;
        }
    }

    if (!mac) {
        // The first advertisement frequently carries no manufacturer data; merge frames until one does.
        const mfData = await waitForManufacturerData(
            device,
            context?.enableAddressSearch ? options.advertisementTimeoutsMs[1] : options.advertisementTimeoutsMs[0],
            {
                earlyExitOnEmptyFirstAdvertisement: false,
                signal: context?.signal,
                // Keep merging until the data actually parses to a MAC: an unrelated
                // manufacturer entry must not preempt a later MAC-bearing frame.
                resolveWhen: (mf) => options.parseFromManufacturerData(mf) !== null,
            }
        );
        mac = options.parseFromManufacturerData(mfData);
    }

    const nameCandidates = !mac && options.candidatesFromName ? options.candidatesFromName(device.name) : [];

    if (!mac && options.useSingleCandidateWithoutProbe && nameCandidates.length === 1) {
        mac = nameCandidates[0]!;
    }

    if (!mac && context?.enableAddressSearch && nameCandidates.length > 0 && options.probe) {
        for (let i = 0; i < nameCandidates.length; i++) {
            // Throw (not break): an aborted resolution must not fall through to the
            // provider fallback below and keep working after cancellation.
            throwIfAborted(context.signal);
            context.onStatus?.(`Testing address (${i + 1}/${nameCandidates.length})…`);
            try {
                if (
                    await options.probe(device, nameCandidates[i]!, {
                        timeoutMs: options.probeTimeoutMs ?? 2000,
                        signal: context.signal,
                    })
                ) {
                    mac = nameCandidates[i]!;
                    break;
                }
            } catch (e) {
                if (isAbortError(e)) {
                    throw e;
                }
                // any other probe failure: this candidate did not validate, try the next
            }
        }
    }

    if (!mac && macProvider) {
        throwIfAborted(context?.signal);
        const r = await macProvider(device, true);
        if (r) {
            mac = r;
        }
    }

    throwIfAborted(context?.signal);
    return mac;
}
