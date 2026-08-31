
import { now } from '../utils';
import { normalizeUuid } from './attachment/normalize-uuid';

function findCharacteristic(
    characteristics: BluetoothRemoteGATTCharacteristic[],
    uuid: string
): BluetoothRemoteGATTCharacteristic | null {
    const targetUuid = normalizeUuid(uuid);
    for (const chrct of characteristics) {
        if (normalizeUuid(chrct.uuid) === targetUuid) {
            return chrct;
        }
    }
    return null;
}

function extractMacFromManufacturerData(
    mfData: BluetoothManufacturerData | DataView | null,
    cicList: number[],
    reversedByteOrder = true
): string | null {
    if (!mfData) return null;

    let dataView: DataView | undefined;

    if (mfData instanceof DataView) {
        dataView = new DataView(mfData.buffer.slice(2));
    } else {
        for (const id of cicList) {
            if (mfData.has(id)) {
                dataView = mfData.get(id);
                break;
            }
        }
    }

    if (!dataView || dataView.byteLength < 6) return null;

    const mac: string[] = [];
    if (reversedByteOrder) {
        for (let i = 5; i >= 0; i--) {
            mac.push((dataView.getUint8(i) + 0x100).toString(16).slice(1));
        }
    } else {
        for (let i = dataView.byteLength - 1; i >= dataView.byteLength - 6; i--) {
            mac.push((dataView.getUint8(i) + 0x100).toString(16).slice(1));
        }
    }
    return mac.join(':');
}

export { now, findCharacteristic, extractMacFromManufacturerData };
