import { normalizeUuid } from './normalize-uuid';
import { abortError, isAbortError, throwIfAborted } from './abort';

const GATT_CONNECT_TIMEOUT_MS = 25_000;
const GATT_RETRY_MAX = 2;
const GATT_RETRY_BASE_DELAY_MS = 150;

function disconnectGattSafe(gatt: BluetoothRemoteGATTServer): Promise<void> {
    return Promise.resolve(
        (gatt as unknown as { disconnect(): Promise<void> }).disconnect()
    ).catch(() => {});
}

async function delay(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

async function connectGattWithTimeout(
    gatt: BluetoothRemoteGATTServer,
    timeoutMs: number,
    signal: AbortSignal | undefined
): Promise<void> {
    const sym = Symbol('gattTimeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
        await Promise.race([
            gatt.connect(),
            new Promise<never>((_, rej) => {
                timer = setTimeout(() => rej(sym), timeoutMs);
            }),
            new Promise<never>((_, rej) => {
                if (!signal) {
                    return;
                }
                onAbort = () => rej(abortError());
                signal.addEventListener('abort', onAbort, { once: true });
            }),
        ]);
    } catch (e) {
        if (e === sym) {
            await disconnectGattSafe(gatt);
            throw new Error('GATT connection timeout');
        }
        await disconnectGattSafe(gatt).catch(() => {});
        throw e;
    } finally {
        clearTimeout(timer);
        if (signal && onAbort) {
            signal.removeEventListener('abort', onAbort);
        }
    }
}

export type CollectPrimaryServiceUuidsOptions = {
    /** Rejects with an AbortError (and disconnects) as soon as the signal fires. */
    signal?: AbortSignal;
};

/**
 * Connect GATT (if needed) and return normalized primary service UUIDs.
 * Uses a connect timeout and limited retries on transient failures.
 */
export async function collectPrimaryServiceUuids(
    device: BluetoothDevice,
    options?: CollectPrimaryServiceUuidsOptions
): Promise<ReadonlySet<string>> {
    const gatt = device.gatt;
    if (!gatt) {
        throw new Error('GATT unavailable on this device');
    }
    const signal = options?.signal;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= GATT_RETRY_MAX; attempt++) {
        throwIfAborted(signal);
        try {
            await connectGattWithTimeout(gatt, GATT_CONNECT_TIMEOUT_MS, signal);
            const services = await gatt.getPrimaryServices();
            const set = new Set<string>();
            for (const s of services) {
                set.add(normalizeUuid(s.uuid));
            }
            return set;
        } catch (e) {
            lastErr = e;
            await disconnectGattSafe(gatt);
            if (isAbortError(e)) {
                throw e;
            }
            if (attempt < GATT_RETRY_MAX) {
                await delay(GATT_RETRY_BASE_DELAY_MS * (attempt + 1));
            }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
