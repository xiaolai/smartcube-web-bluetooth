import aesjs from 'aes-js';

const { ModeOfOperation } = aesjs;

/** Publicly known QiYi protocol key (AES-128-ECB), required for interoperability. */
const QIYI_KEY = [87, 177, 249, 171, 205, 90, 232, 167, 156, 185, 140, 231, 87, 140, 81, 8];

const AES_BLOCK_SIZE = 16;
/** The one-byte frame-length field must hold 4 + content bytes. */
const QIYI_MAX_CONTENT_LENGTH = 251;

/** ECB has no chained state, so one cipher instance serves every frame. */
let cachedCipher: InstanceType<typeof ModeOfOperation.ecb> | null = null;
function cipher(): InstanceType<typeof ModeOfOperation.ecb> {
    return (cachedCipher ??= new ModeOfOperation.ecb(new Uint8Array(QIYI_KEY)));
}

export function crc16modbus(data: ArrayLike<number>): number {
    let crc = 0xffff;
    for (let i = 0; i < data.length; i++) {
        const byte = data[i]!;
        if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
            throw new TypeError(`crc16modbus: value at index ${i} is not a byte: ${byte}`);
        }
        crc ^= byte;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 1) > 0 ? (crc >> 1) ^ 0xa001 : crc >> 1;
        }
    }
    return crc;
}

function assertBlockAligned(length: number, operation: string): void {
    if (length === 0 || length % AES_BLOCK_SIZE !== 0) {
        throw new Error(`QiYi ${operation}: frame length must be a positive multiple of 16, got ${length}`);
    }
}

export function decryptQiYiBlocks(enc: Uint8Array): Uint8Array<ArrayBuffer> {
    assertBlockAligned(enc.length, 'decrypt');
    return new Uint8Array(cipher().decrypt(enc));
}

function encryptQiYiBlocks(plain: Uint8Array): Uint8Array<ArrayBuffer> {
    assertBlockAligned(plain.length, 'encrypt');
    return new Uint8Array(cipher().encrypt(plain));
}

/** Frame `content` as a QiYi message (0xFE magic, length, CRC-16/MODBUS, zero padding) and encrypt it. */
export function encryptQiYiMessage(content: number[]): Uint8Array<ArrayBuffer> {
    if (content.length > QIYI_MAX_CONTENT_LENGTH) {
        throw new Error(`QiYi message content too long: ${content.length} bytes (max ${QIYI_MAX_CONTENT_LENGTH})`);
    }
    const msg: number[] = [0xfe, 4 + content.length, ...content];
    const crc = crc16modbus(msg); // also validates every content value is a byte
    msg.push(crc & 0xff, crc >> 8);
    while (msg.length % AES_BLOCK_SIZE !== 0) {
        msg.push(0);
    }
    return encryptQiYiBlocks(Uint8Array.from(msg));
}

/**
 * Fixed hello/state-request header: app identity/version fields the cube ignores
 * beyond framing; only the trailing reversed MAC is device-specific.
 */
const QIYI_HELLO_PREFIX = Object.freeze([0x00, 0x6b, 0x01, 0x00, 0x00, 0x22, 0x06, 0x00, 0x02, 0x08, 0x00]);

/** Hello/state-request payload; the cube's MAC (reversed) closes the handshake. */
export function qiyiHelloContent(macBytes: number[]): number[] {
    if (macBytes.length !== 6 || macBytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
        throw new Error('QiYi hello requires exactly 6 MAC bytes');
    }
    const content = [...QIYI_HELLO_PREFIX];
    for (let i = 5; i >= 0; i--) {
        content.push(macBytes[i]!);
    }
    return content;
}
