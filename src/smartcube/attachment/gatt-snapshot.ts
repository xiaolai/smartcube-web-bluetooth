import { normalizeUuid } from './normalize-uuid';
import { abortError, isAbortError, throwIfAborted } from './abort';

const GATT_CONNECT_TIMEOUT_MS = 25_000;
const GATT_RETRY_MAX = 2;
const GATT_RETRY_BASE_DELAY_MS = 150;

function disconnectGattSafe(gatt: BluetoothRemoteGATTServer): Promise<void> {
    try {
        return Promise.resolve(
            (gatt as unknown as { disconnect(): Promise<void> }).disconnect()
        ).catch(() => {});
    } catch {
        // a synchronous throw from disconnect() must not mask the original failure
        return Promise.resolve();
    }
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** Race any GATT operation against the abort signal, cleaning up the listener. */
function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) {
        return work;
    }
    let onAbort: (() => void) | undefined;
    return Promise.race([
        work,
        new Promise<never>((_, reject) => {
            onAbort = () => reject(abortError());
            signal.addEventListener('abort', onAbort, { once: true });
        }),
    ]).finally(() => {
        if (onAbort) {
            signal.removeEventListener('abort', onAbort);
        }
    });
}

async function connectGattWithTimeout(
    gatt: BluetoothRemoteGATTServer,
    timeoutMs: number,
    signal: AbortSignal | undefined
): Promise<void> {
    const sym = Symbol('gattTimeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await raceWithAbort(
            Promise.race([
                gatt.connect(),
                new Promise<never>((_, rej) => {
                    timer = setTimeout(() => rej(sym), timeoutMs);
                }),
            ]),
            signal,
        );
    } catch (e) {
        // Disconnection ownership lies with the caller's retry loop.
        if (e === sym) {
            throw new Error('GATT connection timeout');
        }
        throw e;
    } finally {
        clearTimeout(timer);
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
            // Service discovery can stall on some stacks: honour the abort here too,
            // not just during connect.
            const services = await raceWithAbort(gatt.getPrimaryServices(), signal);
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
                await abortableDelay(GATT_RETRY_BASE_DELAY_MS * (attempt + 1), signal);
            }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
