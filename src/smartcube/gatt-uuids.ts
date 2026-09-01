/**
 * GATT service and characteristic UUIDs for every non-GAN brand, in one place. Drivers, MAC
 * probes and the picker all import from here so a UUID is never written twice. GAN's live in
 * gan-cube-definitions.ts alongside its keys.
 */

/** Suffix of the Bluetooth Base UUID: a 16-bit SIG-assigned UUID `XXXX` expands to `0000XXXX` + this. */
export const BLUETOOTH_BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';

/** Expand a 16-bit UUID (`'fff0'`) to its 128-bit form. */
export function uuidFromShort(short: string): string {
    return `0000${short}${BLUETOOTH_BASE_UUID_SUFFIX}`;
}

// Standard profiles granted on every requestDevice call.
export const GENERIC_ACCESS_SERVICE = uuidFromShort('1800');
export const DEVICE_INFORMATION_SERVICE = uuidFromShort('180a');

// QiYi (also XMD Tornado V4 i). fff0 is not QiYi-specific: GAN gen1 and the GAN timer use it too.
export const QIYI_SERVICE = uuidFromShort('fff0');
export const QIYI_CUBE_CHARACTERISTIC = uuidFromShort('fff6');

// MoYu MHC ("plain" MoYu BLE API v1).
export const MOYU_MHC_SERVICE = uuidFromShort('1000');
export const MOYU_MHC_WRITE_CHARACTERISTIC = uuidFromShort('1001');
export const MOYU_MHC_READ_CHARACTERISTIC = uuidFromShort('1002');
export const MOYU_MHC_TURN_CHARACTERISTIC = uuidFromShort('1003');
export const MOYU_MHC_GYRO_CHARACTERISTIC = uuidFromShort('1004');

// MoYu32 / WCU.
export const MOYU32_SERVICE = '0783b03e-7735-b5a0-1760-a305d2795cb0';
export const MOYU32_READ_CHARACTERISTIC = '0783b03e-7735-b5a0-1760-a305d2795cb1';
export const MOYU32_WRITE_CHARACTERISTIC = '0783b03e-7735-b5a0-1760-a305d2795cb2';

// Giiker: state on the data service; battery/reset on the optional control service.
export const GIIKER_DATA_SERVICE = uuidFromShort('aadb');
export const GIIKER_DATA_CHARACTERISTIC = uuidFromShort('aadc');
export const GIIKER_CONTROL_SERVICE = uuidFromShort('aaaa');
export const GIIKER_CONTROL_READ_CHARACTERISTIC = uuidFromShort('aaab');
export const GIIKER_CONTROL_WRITE_CHARACTERISTIC = uuidFromShort('aaac');

// GoCube / Rubik's Connected: Nordic-style UART.
const GOCUBE_UART_SUFFIX = '-b5a3-f393-e0a9-e50e24dcca9e';
export const GOCUBE_UART_SERVICE = '6e400001' + GOCUBE_UART_SUFFIX;
export const GOCUBE_UART_WRITE_CHARACTERISTIC = '6e400002' + GOCUBE_UART_SUFFIX;
export const GOCUBE_UART_READ_CHARACTERISTIC = '6e400003' + GOCUBE_UART_SUFFIX;
