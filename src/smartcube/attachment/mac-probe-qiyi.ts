import { findCharacteristic } from '../ble-utils';
import { writeGattCharacteristicValue } from '../../gatt-characteristic-write';
import { parseMacBytes } from './mac-address';
import { decryptQiYiBlocks, encryptQiYiMessage, qiyiHelloContent } from './qiyi-wire';
import { isValidQiYiDecryptedPacket } from './packet-sanity';
import { throwIfAborted } from './abort';

const UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const QIYI_SVC = '0000fff0' + UUID_SUFFIX;
const QIYI_CHR = '0000fff6' + UUID_SUFFIX;
const HELLO_RETRY_INTERVAL_MS = 200;

/**
 * Returns true if the cube answers our hello handshake for this MAC candidate.
 * QiYi decryption uses a fixed key, so only a hello response (validated in
 * isValidQiYiDecryptedPacket) is evidence for the candidate.
 * Throws AbortError when the signal fires; other failures report false.
 */
export async function probeQiYiMac(
    device: BluetoothDevice,
    mac: string,
    options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<boolean> {
    const timeoutMs = options?.timeoutMs ?? 3000;
    const signal = options?.signal;
    throwIfAborted(signal);
    const helloFrame = encryptQiYiMessage(qiyiHelloContent(parseMacBytes(mac)));
    const gatt = device.gatt;
    if (!gatt) {
        return false;
    }
    if (!gatt.connected) {
        await gatt.connect();
        throwIfAborted(signal);
    }
    const service = await gatt.getPrimaryService(QIYI_SVC);
    throwIfAborted(signal);
    const chrcts = await service.getCharacteristics();
    throwIfAborted(signal);
    const chrct = findCharacteristic(chrcts, QIYI_CHR);
    if (!chrct) {
        return false;
    }

    let ok = false;
    let settled = false;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
        settle = () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };
    });

    const onNotify = (ev: Event): void => {
        if (settled) {
            return;
        }
        const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
        if (!v) {
            return;
        }
        try {
            const raw = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
            const dec = decryptQiYiBlocks(raw);
            if (isValidQiYiDecryptedPacket(dec)) {
                ok = true;
                settle();
            }
        } catch {
            // a frame that is not a whole number of AES blocks: not ours, keep listening
        }
    };
    const onAbort = (): void => settle();

    const maxTimer = setTimeout(settle, timeoutMs);
    let notificationsStarted = false;
    chrct.addEventListener('characteristicvaluechanged', onNotify);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        await chrct.startNotifications();
        notificationsStarted = true;

        // Awaited hello retry loop: no fire-and-forget writes can outlive the probe
        // and race the teardown or a later candidate's probe.
        while (!settled) {
            try {
                await writeGattCharacteristicValue(chrct, helloFrame);
            } catch {
                // transient write failure: keep retrying until the timeout settles us
            }
            if (settled) {
                break;
            }
            await Promise.race([
                done,
                new Promise((r) => setTimeout(r, HELLO_RETRY_INTERVAL_MS)),
            ]);
        }
        await done;
    } finally {
        settle();
        clearTimeout(maxTimer);
        signal?.removeEventListener('abort', onAbort);
        chrct.removeEventListener('characteristicvaluechanged', onNotify);
        if (notificationsStarted) {
            await chrct.stopNotifications().catch(() => {});
        }
    }
    throwIfAborted(signal);
    return ok;
}
