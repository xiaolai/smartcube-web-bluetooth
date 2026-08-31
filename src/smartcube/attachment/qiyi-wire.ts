import aesjs from 'aes-js';

const { ModeOfOperation } = aesjs;

/** Publicly known QiYi protocol key (AES-128-ECB), required for interoperability. */
const QIYI_KEY = [87, 177, 249, 171, 205, 90, 232, 167, 156, 185, 140, 231, 87, 140, 81, 8];

/** ECB has no chained state, so one cipher instance serves every frame. */
let cachedCipher: InstanceType<typeof ModeOfOperation.ecb> | null = null;
function cipher(): InstanceType<typeof ModeOfOperation.ecb> {
    return (cachedCipher ??= new ModeOfOperation.ecb(new Uint8Array(QIYI_KEY)));
}

export function crc16modbus(data: ArrayLike<number>): number {
    let crc = 0xffff;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i]!;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 1) > 0 ? (crc >> 1) ^ 0xa001 : crc >> 1;
        }
    }
    return crc;
}

export function decryptQiYiBlocks(enc: Uint8Array): Uint8Array<ArrayBuffer> {
    const c = cipher();
    const out = new Uint8Array(enc.length);
    for (let i = 0; i < enc.length; i += 16) {
        out.set(c.decrypt(enc.subarray(i, i + 16)), i);
    }
    return out;
}

function encryptQiYiBlocks(plain: Uint8Array): Uint8Array<ArrayBuffer> {
    const c = cipher();
    const out = new Uint8Array(plain.length);
    for (let i = 0; i < plain.length; i += 16) {
        out.set(c.encrypt(plain.subarray(i, i + 16)), i);
    }
    return out;
}

/** Frame `content` as a QiYi message (0xFE magic, length, CRC-16/MODBUS, zero padding) and encrypt it. */
export function encryptQiYiMessage(content: number[]): Uint8Array<ArrayBuffer> {
    const msg: number[] = [0xfe, 4 + content.length, ...content];
    const crc = crc16modbus(msg);
    msg.push(crc & 0xff, crc >> 8);
    while (msg.length % 16 !== 0) {
        msg.push(0);
    }
    return encryptQiYiBlocks(Uint8Array.from(msg));
}

/** Hello/state-request payload; the cube's MAC (reversed) closes the handshake. */
export function qiyiHelloContent(macBytes: number[]): number[] {
    const content = [0x00, 0x6b, 0x01, 0x00, 0x00, 0x22, 0x06, 0x00, 0x02, 0x08, 0x00];
    for (let i = 5; i >= 0; i--) {
        content.push(macBytes[i] ?? 0);
    }
    return content;
}
