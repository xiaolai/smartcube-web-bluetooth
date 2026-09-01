import { DEVICE_INFORMATION_SERVICE, GENERIC_ACCESS_SERVICE } from '../gatt-uuids';

/**
 * Services granted on every `requestDevice` call regardless of which drivers are registered:
 * the standard profiles a driver may read next to its own service. Brand services are not
 * listed here — each protocol declares its own in `optionalServices`, and the picker merges
 * those in, so a UUID never has to be kept in two places.
 */
export const DEFAULT_SMARTCUBE_OPTIONAL_SERVICES: readonly string[] = [
    GENERIC_ACCESS_SERVICE,
    DEVICE_INFORMATION_SERVICE,
];

export function mergeOptionalServiceUuids(protocolServices: Iterable<string>): string[] {
    const u = new Set<string>(DEFAULT_SMARTCUBE_OPTIONAL_SERVICES);
    for (const s of protocolServices) {
        u.add(s);
    }
    return Array.from(u);
}

// SUPERSEDED: every entry below is either declared by its protocol's `optionalServices` (and merged
// in by buildRequestDeviceOptions) or is a characteristic, which `optionalServices` does not grant.
// import * as gan from '../../gan-cube-definitions';
//
// const S = '-0000-1000-8000-00805f9b34fb';
//
// export const DEVICE_INFORMATION_SERVICE = '0000180a' + S;
// export const GENERIC_ACCESS_SERVICE = '00001800' + S;
//
// /** QiYi primary (16-bit FFF0). */
// export const QIYI_LIKE_FFF0 = '0000fff0' + S;
//
// /** MoYu plain (MHC). */
// export const MOYU_PLAIN_SERVICE = '00001000' + S;
//
// /** MoYu32 / WCU. */
// export const MOYU32_SERVICE = '0783b03e-7735-b5a0-1760-a305d2795cb0';
//
// /** Giiker. */
// export const GIIKER_DATA_SERVICE = '0000aadb' + S;
// export const GIIKER_CTRL_SERVICE = '0000aaaa' + S;
//
// /** GoCube UART. */
// export const GOCUBE_UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
//
// export const DEFAULT_SMARTCUBE_OPTIONAL_SERVICES: readonly string[] = [
//     GENERIC_ACCESS_SERVICE,
//     DEVICE_INFORMATION_SERVICE,
//     gan.GAN_GEN2_SERVICE,
//     gan.GAN_GEN2_COMMAND_CHARACTERISTIC,
//     gan.GAN_GEN2_STATE_CHARACTERISTIC,
//     gan.GAN_GEN3_SERVICE,
//     gan.GAN_GEN3_COMMAND_CHARACTERISTIC,
//     gan.GAN_GEN3_STATE_CHARACTERISTIC,
//     gan.GAN_GEN4_SERVICE,
//     gan.GAN_GEN4_COMMAND_CHARACTERISTIC,
//     gan.GAN_GEN4_STATE_CHARACTERISTIC,
//     QIYI_LIKE_FFF0,
//     MOYU_PLAIN_SERVICE,
//     MOYU32_SERVICE,
//     GIIKER_DATA_SERVICE,
//     GIIKER_CTRL_SERVICE,
//     GOCUBE_UART_SERVICE,
// ];
