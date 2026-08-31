import * as ganDef from '../../gan-cube-definitions';

const STORAGE_PREFIX = 'smartcube-ble-mac:';

export function getCachedMacForDevice(device: BluetoothDevice): string | null {
    if (typeof localStorage === 'undefined') {
        return null;
    }
    try {
        return localStorage.getItem(STORAGE_PREFIX + device.id);
    } catch {
        return null;
    }
}

export function setCachedMacForDevice(device: BluetoothDevice, mac: string): void {
    if (typeof localStorage === 'undefined') {
        return;
    }
    try {
        localStorage.setItem(STORAGE_PREFIX + device.id, mac);
    } catch {
        /* ignore quota */
    }
}

export function removeCachedMacForDevice(device: BluetoothDevice): void {
    if (typeof localStorage === 'undefined') {
        return;
    }
    try {
        localStorage.removeItem(STORAGE_PREFIX + device.id);
    } catch {
        /* ignore */
    }
}

function mergeManufacturerDataInto(
    acc: Map<number, DataView>,
    mf: BluetoothManufacturerData | null | undefined
): void {
    if (!mf || typeof mf.keys !== 'function') {
        return;
    }
    for (const id of mf.keys()) {
        const v = mf.get(id);
        if (v) {
            acc.set(
                id,
                new DataView(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
            );
        }
    }
}

export type WaitForManufacturerDataOptions = {
    /**
     * Resolve `null` as soon as the first advertisement arrives without manufacturer data,
     * instead of merging frames until the timeout. Defaults to true for `WCU_*` names (MoYu32
     * rarely exposes useful data in the pre-connect pass; keeps connect snappy) and false
     * otherwise. Pass `false` when the address is actually needed.
     */
    earlyExitOnEmptyFirstAdvertisement?: boolean;
    /** Resolves `null` immediately when aborted; the caller decides whether that is an error. */
    signal?: AbortSignal;
};

/**
 * Wait for manufacturer data from advertisements (single shared listener).
 * Merges all packets until timeout: the first BLE advertisement often has an empty
 * manufacturerData map; MAC-bearing data appears on later frames.
 */
export async function waitForManufacturerData(
    device: BluetoothDevice,
    timeoutMs = 5000,
    options?: WaitForManufacturerDataOptions
): Promise<BluetoothManufacturerData | null> {
    if (typeof device.watchAdvertisements !== 'function') {
        return null;
    }
    const name = (device.name || '').trim();
    const emptyFirstAdvExit = options?.earlyExitOnEmptyFirstAdvertisement ?? name.startsWith('WCU_');
    const signal = options?.signal;
    if (signal?.aborted) {
        return null;
    }

    return new Promise<BluetoothManufacturerData | null>((resolve) => {
        const abortController = new AbortController();
        const merged = new Map<number, DataView>();
        let sawAdvertisement = false;
        let finished = false;

        const onAbort = (): void => {
            finish(null);
        };

        const cleanup = (): void => {
            device.removeEventListener('advertisementreceived', onAdvEvent);
            signal?.removeEventListener('abort', onAbort);
            abortController.abort();
            clearTimeout(maxTimer);
        };

        const finish = (value: BluetoothManufacturerData | null): void => {
            if (finished) {
                return;
            }
            finished = true;
            cleanup();
            resolve(value);
        };

        const onAdvEvent = (evt: Event): void => {
            const adv = evt as BluetoothAdvertisingEvent;
            mergeManufacturerDataInto(merged, adv.manufacturerData ?? null);
            const isFirstAdv = !sawAdvertisement;
            sawAdvertisement = true;

            if (merged.size > 0) {
                finish(merged as unknown as BluetoothManufacturerData);
                return;
            }
            if (emptyFirstAdvExit && isFirstAdv) {
                finish(null);
            }
        };

        const maxTimer = setTimeout(() => {
            finish(merged.size > 0 ? (merged as unknown as BluetoothManufacturerData) : null);
        }, timeoutMs);

        device.addEventListener('advertisementreceived', onAdvEvent);
        signal?.addEventListener('abort', onAbort, { once: true });
        device.watchAdvertisements({ signal: abortController.signal }).catch(() => {
            clearTimeout(maxTimer);
            finish(null);
        });
    });
}

/** GAN-style MAC from manufacturer data (last 6 bytes, reversed order in payload). */
export function macFromGanManufacturerData(mf: BluetoothManufacturerData | DataView): string | null {
    function getBytes(manufacturerData: BluetoothManufacturerData | DataView): DataView | undefined {
        // Slice relative to the view's own bounds: a manufacturer-data DataView can be a
        // subview of a larger advertisement buffer, and buffer.slice(0, …) would read
        // unrelated bytes and derive the wrong MAC.
        if (manufacturerData instanceof DataView) {
            const start = manufacturerData.byteOffset + 2;
            const end = manufacturerData.byteOffset + Math.min(manufacturerData.byteLength, 11);
            return new DataView(manufacturerData.buffer.slice(start, Math.max(start, end)));
        }
        for (const id of ganDef.GAN_CIC_LIST) {
            if (manufacturerData.has(id)) {
                const value = manufacturerData.get(id)!;
                const start = value.byteOffset;
                const end = value.byteOffset + Math.min(value.byteLength, 9);
                return new DataView(value.buffer.slice(start, end));
            }
        }
        return undefined;
    }
    const dataView = getBytes(mf);
    if (!dataView || dataView.byteLength < 6) {
        return null;
    }
    const mac: string[] = [];
    for (let i = 1; i <= 6; i++) {
        mac.push(dataView.getUint8(dataView.byteLength - i).toString(16).toUpperCase().padStart(2, '0'));
    }
    return mac.join(':');
}
