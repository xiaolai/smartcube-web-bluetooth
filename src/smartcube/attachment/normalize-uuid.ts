import { uuidFromShort } from '../gatt-uuids';

/** Normalize BLE UUID to 128-bit uppercase (16-bit UUIDs expanded per SIG base). */
export function normalizeUuid(uuid: string): string {
    return (/^[0-9A-Fa-f]{4}$/.test(uuid) ? uuidFromShort(uuid) : uuid).toUpperCase();
    // SUPERSEDED: the base-UUID suffix now lives in gatt-uuids.ts.
    // let u = uuid;
    // if (/^[0-9A-Fa-f]{4}$/.exec(u)) {
    //     u = '0000' + u + '-0000-1000-8000-00805F9B34FB';
    // }
    // return u.toUpperCase();
}
