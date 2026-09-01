
// SUPERSEDED: `now` is imported from utils, where it is defined; ble-utils no longer re-exports it.
// import { now } from '../utils';
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
        // Slice relative to the view's bounds: buffer.slice(2) ignores byteOffset and
        // reads unrelated bytes when the DataView is a subview of a larger buffer.
        dataView = new DataView(
            mfData.buffer.slice(mfData.byteOffset + 2, mfData.byteOffset + mfData.byteLength),
        );
    } else {
        for (const id of cicList) {
            const value = mfData.get(id);
            if (value && value.byteLength >= 6) {
                dataView = value;
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
        for (let i = dataView.byteLength - 6; i < dataView.byteLength; i++) {
            mac.push((dataView.getUint8(i) + 0x100).toString(16).slice(1));
        }
    }
    return mac.join(':');
}

export { findCharacteristic, extractMacFromManufacturerData };
// SUPERSEDED: see the import note above.
// export { now, findCharacteristic, extractMacFromManufacturerData };
