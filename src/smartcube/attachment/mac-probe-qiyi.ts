import { findCharacteristic } from '../ble-utils';
import { writeGattCharacteristicValue } from '../../gatt-characteristic-write';
import { parseMacBytes } from './mac-address';
import { decryptQiYiBlocks, encryptQiYiMessage, qiyiHelloContent } from './qiyi-wire';
import { isValidQiYiDecryptedPacket } from './packet-sanity';

const UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const QIYI_SVC = '0000fff0' + UUID_SUFFIX;
const QIYI_CHR = '0000fff6' + UUID_SUFFIX;
/**
 * Returns true if notifications decrypt to plausible QiYi payloads for this MAC.
 */
export async function probeQiYiMac(
    device: BluetoothDevice,
    mac: string,
    options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<boolean> {
    const timeoutMs = options?.timeoutMs ?? 3000;
    const helloFrame = encryptQiYiMessage(qiyiHelloContent(parseMacBytes(mac)));
    const gatt = device.gatt;
    if (!gatt) {
        return false;
    }
    if (!gatt.connected) {
        await gatt.connect();
    }
    const service = await gatt.getPrimaryService(QIYI_SVC);
    const chrcts = await service.getCharacteristics();
    const chrct = findCharacteristic(chrcts, QIYI_CHR);
    if (!chrct) {
        return false;
    }

    let stopped = false;
    let ok = false;

    const onNotify = (ev: Event): void => {
        if (stopped) {
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
                stopped = true;
            }
        } catch {
            /* ignore */
        }
    };

    chrct.addEventListener('characteristicvaluechanged', onNotify);
    await chrct.startNotifications();

    const wake = (): void => {
        if (stopped) {
            return;
        }
        try {
            void writeGattCharacteristicValue(chrct, helloFrame).catch(() => {});
        } catch {
            /* ignore */
        }
    };

    const iv = setInterval(wake, 100);
    wake();

    await new Promise<void>((resolve) => {
        const maxTimer = setTimeout(() => resolve(), timeoutMs);
        const poll = setInterval(() => {
            if (ok || options?.signal?.aborted) {
                clearInterval(poll);
                clearTimeout(maxTimer);
                resolve();
            }
        }, 40);
    });

    clearInterval(iv);
    stopped = true;
    chrct.removeEventListener('characteristicvaluechanged', onNotify);
    await chrct.stopNotifications().catch(() => {});

    return ok;
}
