import aesjs from 'aes-js';
import { parseMacBytes } from './mac-address';

const { ModeOfOperation } = aesjs;

const BASE_KEY = [21, 119, 58, 92, 103, 14, 45, 31, 23, 103, 42, 19, 155, 103, 82, 87];
const BASE_IV = [17, 35, 38, 37, 134, 42, 44, 59, 85, 6, 127, 49, 126, 103, 33, 87];

const AES_BLOCK_SIZE = 16;
const MAC_BYTE_LENGTH = 6;

export interface Moyu32SessionCrypto {
    decrypt(raw: number[]): number[];
    encrypt(data: number[]): number[];
}

/** MoYu32 AES session crypto keyed by device address; the protocol driver and the MAC probe share it. */
export function createMoyu32SessionCrypto(mac: string): Moyu32SessionCrypto {
    const macBytes = parseMacBytes(mac);
    const key = BASE_KEY.slice();
    const iv = BASE_IV.slice();
    for (let i = 0; i < MAC_BYTE_LENGTH; i++) {
        key[i] = (key[i]! + macBytes[MAC_BYTE_LENGTH - 1 - i]!) % 255;
        iv[i] = (iv[i]! + macBytes[MAC_BYTE_LENGTH - 1 - i]!) % 255;
    }
    // ECB keeps no chained state, so one cipher instance serves the whole session.
    const cipher = new ModeOfOperation.ecb(new Uint8Array(key));

    const decryptBlock = (buffer: number[], offset: number): void => {
        const block = cipher.decrypt(Uint8Array.from(buffer.slice(offset, offset + AES_BLOCK_SIZE)));
        for (let i = 0; i < AES_BLOCK_SIZE; i++) {
            buffer[offset + i] = block[i]! ^ iv[i]!;
        }
    };
    const encryptBlock = (buffer: number[], offset: number): void => {
        for (let i = 0; i < AES_BLOCK_SIZE; i++) {
            buffer[offset + i]! ^= iv[i]!;
        }
        const block = cipher.encrypt(Uint8Array.from(buffer.slice(offset, offset + AES_BLOCK_SIZE)));
        for (let i = 0; i < AES_BLOCK_SIZE; i++) {
            buffer[offset + i] = block[i]!;
        }
    };

    return {
        decrypt(raw: number[]): number[] {
            if (raw.length < AES_BLOCK_SIZE) {
                throw new Error(`MoYu32 frame too short to decrypt: ${raw.length} bytes`);
            }
            const ret = raw.slice();
            if (ret.length > AES_BLOCK_SIZE) {
                decryptBlock(ret, ret.length - AES_BLOCK_SIZE);
            }
            decryptBlock(ret, 0);
            return ret;
        },
        encrypt(data: number[]): number[] {
            if (data.length < AES_BLOCK_SIZE) {
                throw new Error(`MoYu32 frame too short to encrypt: ${data.length} bytes`);
            }
            const ret = data.slice();
            encryptBlock(ret, 0);
            if (ret.length > AES_BLOCK_SIZE) {
                encryptBlock(ret, ret.length - AES_BLOCK_SIZE);
            }
            return ret;
        },
    };
}
