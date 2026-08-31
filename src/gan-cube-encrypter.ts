
import aesjs from 'aes-js';

// aes-js ships CommonJS only; a default import resolves in Node ESM, CJS and every bundler.

/** aes-js block-cipher core with a precomputed key schedule (its typings only expose ByteSource). */
type AesBlockCipher = { encrypt(block: number[]): number[]; decrypt(block: number[]): number[] };

/**
 * Common cube encrypter interface
 */
interface GanCubeEncrypter {
    /** Encrypt binary message buffer represented as Uint8Array */
    encrypt(data: Uint8Array): Uint8Array;
    /** Decrypt binary message buffer represented as Uint8Array */
    decrypt(data: Uint8Array): Uint8Array;
}

/**
 * Implementation for encryption scheme used in the GAN Gen2 Smart Cubes
 */
class GanGen2CubeEncrypter implements GanCubeEncrypter {

    private _key: Uint8Array;
    private _iv: Uint8Array;
    private readonly aes: AesBlockCipher;

    constructor(key: Uint8Array, iv: Uint8Array, salt: Uint8Array) {
        if (key.length != 16)
            throw new Error("Key must be 16 bytes (128-bit) long");
        if (iv.length != 16)
            throw new Error("Iv must be 16 bytes (128-bit) long");
        if (salt.length != 6)
            throw new Error("Salt must be 6 bytes (48-bit) long");
        // Apply salt to key and iv
        this._key = new Uint8Array(key);
        this._iv = new Uint8Array(iv);
        for (let i = 0; i < 6; i++) {
            this._key[i] = (key[i] + salt[i]) % 0xFF;
            this._iv[i] = (iv[i] + salt[i]) % 0xFF;
        }
        this.aes = new aesjs.AES([...this._key]) as unknown as AesBlockCipher;
    }

    /**
     * Encrypt a 16-byte chunk at offset. Equivalent to single-block AES-128-CBC with the fixed
     * iv (E(chunk XOR iv)), but reuses one precomputed key schedule instead of rebuilding the
     * cipher for every chunk of every packet.
     */
    private encryptChunk(buffer: Uint8Array, offset: number): void {
        const block: number[] = new Array(16);
        for (let i = 0; i < 16; i++) {
            block[i] = buffer[offset + i]! ^ this._iv[i]!;
        }
        buffer.set(this.aes.encrypt(block), offset);
    }

    /** Decrypt a 16-byte chunk at offset: single-block AES-128-CBC, D(chunk) XOR iv. */
    private decryptChunk(buffer: Uint8Array, offset: number): void {
        const decrypted = this.aes.decrypt(Array.from(buffer.subarray(offset, offset + 16)));
        for (let i = 0; i < 16; i++) {
            buffer[offset + i] = decrypted[i]! ^ this._iv[i]!;
        }
    }

    encrypt(data: Uint8Array): Uint8Array {
        if (data.length < 16)
            throw Error('Data must be at least 16 bytes long');
        var res = new Uint8Array(data);
        // encrypt 16-byte chunk aligned to message start
        this.encryptChunk(res, 0);
        // encrypt 16-byte chunk aligned to message end
        if (res.length > 16) {
            this.encryptChunk(res, res.length - 16);
        }
        return res;
    }

    decrypt(data: Uint8Array): Uint8Array {
        if (data.length < 16)
            throw Error('Data must be at least 16 bytes long');
        var res = new Uint8Array(data);
        // decrypt 16-byte chunk aligned to message end
        if (res.length > 16) {
            this.decryptChunk(res, res.length - 16);
        }
        // decrypt 16-byte chunk aligned to message start
        this.decryptChunk(res, 0);
        return res;
    }

}

export type {
    GanCubeEncrypter
};

// Gen3 and gen4 use the same MAC-salted AES-128 scheme as gen2; the per-generation names are
// kept for clarity at call sites and for backwards compatibility.
export {
    GanGen2CubeEncrypter,
    GanGen2CubeEncrypter as GanGen3CubeEncrypter,
    GanGen2CubeEncrypter as GanGen4CubeEncrypter
};

