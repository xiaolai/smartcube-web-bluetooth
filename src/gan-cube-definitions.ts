/** Key/iv used by GAN Gen2, Gen3 and Gen4 cubes (also gen1 key-table rows 2/3). */
const GAN_GEN2_BASE_KEY: readonly number[] = Object.freeze(
    [0x01, 0x02, 0x42, 0x28, 0x31, 0x91, 0x16, 0x07, 0x20, 0x05, 0x18, 0x54, 0x42, 0x11, 0x12, 0x53]);
const GAN_GEN2_BASE_IV: readonly number[] = Object.freeze(
    [0x11, 0x03, 0x32, 0x28, 0x21, 0x01, 0x76, 0x27, 0x20, 0x95, 0x78, 0x14, 0x32, 0x12, 0x02, 0x43]);
/** Key/iv used by MoYu AI 2023 (also gen1 key-table rows 4/5). */
const MOYU_AI_2023_KEY: readonly number[] = Object.freeze(
    [0x05, 0x12, 0x02, 0x45, 0x02, 0x01, 0x29, 0x56, 0x12, 0x78, 0x12, 0x76, 0x81, 0x01, 0x08, 0x03]);
const MOYU_AI_2023_IV: readonly number[] = Object.freeze(
    [0x01, 0x44, 0x28, 0x06, 0x86, 0x21, 0x22, 0x28, 0x51, 0x05, 0x08, 0x31, 0x82, 0x02, 0x21, 0x06]);

/**
 * AES-128 base key tables for GAN gen1 `deriveGen1Key`, indexed by the firmware major byte.
 * Previously stored LZ-compressed; decoded once with lz-string 1.5.0 `decompressFromEncodedURIComponent`.
 * Rows 2-5 are the gen2 and MoYu key/iv above - one source of truth for those bytes.
 */
export const GAN_GEN1_KEYS: readonly (readonly number[])[] = Object.freeze([
    Object.freeze([198, 202, 21, 223, 79, 110, 19, 182, 119, 13, 230, 89, 58, 175, 186, 162]),
    Object.freeze([67, 226, 91, 214, 125, 220, 120, 216, 7, 96, 163, 218, 130, 60, 1, 241]),
    GAN_GEN2_BASE_KEY,
    GAN_GEN2_BASE_IV,
    MOYU_AI_2023_KEY,
    MOYU_AI_2023_IV,
]);

/** GAN gen1 primary GATT service (356i “API v1”). */
export const GAN_GEN1_PRIMARY_SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb";
/** Standard Device Information service (gen1 key derivation). */
export const GAN_GEN1_DEVICE_INFO_SERVICE = "0000180a-0000-1000-8000-00805f9b34fb";
export const GAN_GEN1_CHR_FIRMWARE = "00002a28-0000-1000-8000-00805f9b34fb";
export const GAN_GEN1_CHR_HARDWARE = "00002a23-0000-1000-8000-00805f9b34fb";
export const GAN_GEN1_CHR_STATE = "0000fff5-0000-1000-8000-00805f9b34fb";
export const GAN_GEN1_CHR_MOVES = "0000fff6-0000-1000-8000-00805f9b34fb";
export const GAN_GEN1_CHR_GYRO_NOTIFY = "0000fff4-0000-1000-8000-00805f9b34fb";
export const GAN_GEN1_CHR_BATTERY = "0000fff7-0000-1000-8000-00805f9b34fb";
export const GAN_GEN1_CHR_FACELETS = "0000fff2-0000-1000-8000-00805f9b34fb";

/** GAN Gen2 protocol BLE service */
export const GAN_GEN2_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dc4179";
/** GAN Gen2 protocol BLE command characteristic */
export const GAN_GEN2_COMMAND_CHARACTERISTIC = "28be4a4a-cd67-11e9-a32f-2a2ae2dbcce4";
/** GAN Gen2 protocol BLE state characteristic */
export const GAN_GEN2_STATE_CHARACTERISTIC = "28be4cb6-cd67-11e9-a32f-2a2ae2dbcce4";

/** GAN Gen3 protocol BLE service */
export const GAN_GEN3_SERVICE = "8653000a-43e6-47b7-9cb0-5fc21d4ae340";
/** GAN Gen3 protocol BLE command characteristic */
export const GAN_GEN3_COMMAND_CHARACTERISTIC = "8653000c-43e6-47b7-9cb0-5fc21d4ae340";
/** GAN Gen3 protocol BLE state characteristic */
export const GAN_GEN3_STATE_CHARACTERISTIC = "8653000b-43e6-47b7-9cb0-5fc21d4ae340";

/** GAN Gen4 protocol BLE service */
export const GAN_GEN4_SERVICE = "00000010-0000-fff7-fff6-fff5fff4fff0";
/** GAN Gen4 protocol BLE command characteristic */
export const GAN_GEN4_COMMAND_CHARACTERISTIC = "0000fff5-0000-1000-8000-00805f9b34fb";
/** GAN Gen4 protocol BLE state characteristic */
export const GAN_GEN4_STATE_CHARACTERISTIC = "0000fff6-0000-1000-8000-00805f9b34fb";

/** Advertised-name prefixes the picker matches: GAN cubes, Monster Go, and MoYu AI 2023 (which speaks gen2). */
export const GAN_NAME_PREFIXES: readonly string[] = Object.freeze(['GAN', 'MG', 'AiCube']);

/** Every service a GAN connection may open, across generations; the picker must be granted all of them. */
export const GAN_OPTIONAL_SERVICES: readonly string[] = Object.freeze([
    GAN_GEN1_PRIMARY_SERVICE,
    GAN_GEN1_DEVICE_INFO_SERVICE,
    GAN_GEN2_SERVICE,
    GAN_GEN3_SERVICE,
    GAN_GEN4_SERVICE,
]);

/** List of Company Identifier Codes, fill with all values [0x0001, 0xFF01] possible for GAN cubes */
export const GAN_CIC_LIST: readonly number[] = Object.freeze(
    Array(256).fill(undefined).map((_v, i) => (i << 8) | 0x01));

/**  List of encryption keys */
export const GAN_ENCRYPTION_KEYS: readonly { readonly key: readonly number[]; readonly iv: readonly number[] }[] =
    Object.freeze([
        Object.freeze({ /** Key used by GAN Gen2, Gen3 and Gen4 cubes */
            key: GAN_GEN2_BASE_KEY,
            iv: GAN_GEN2_BASE_IV
        }),
        Object.freeze({ /** Key used by MoYu AI 2023 */
            key: MOYU_AI_2023_KEY,
            iv: MOYU_AI_2023_IV
        })
    ]);

