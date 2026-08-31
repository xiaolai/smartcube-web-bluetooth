/**
 * Big-endian bit-stream reader for decrypted GAN protocol messages.
 *
 * Runs on the notification hot path (gyro streams at 50–100 Hz), so it reads bits directly
 * from the bytes instead of building a binary string per message. Out-of-range semantics
 * mirror the previous string-based implementation exactly: a read past the end truncates to
 * the available bits, an entirely out-of-range read yields NaN, and missing bytes in 16/32-bit
 * reads become zero.
 */
export class GanBitReader {
    private readonly bytes: Uint8Array;
    private readonly bitLength: number;

    constructor(message: Uint8Array | readonly number[]) {
        this.bytes = message instanceof Uint8Array ? message : Uint8Array.from(message);
        this.bitLength = this.bytes.length * 8;
    }

    private readBits(offset: number, count: number): number {
        const available = Math.min(count, this.bitLength - offset);
        if (available <= 0) {
            return NaN;
        }
        let value = 0;
        for (let i = 0; i < available; i++) {
            const idx = offset + i;
            value = (value << 1) | ((this.bytes[idx >> 3]! >> (7 - (idx & 7))) & 1);
        }
        return value;
    }

    getBitWord(offset: number, bitLength: number, littleEndian = false): number {
        if (bitLength <= 8) {
            return this.readBits(offset, bitLength);
        }
        if (bitLength === 16 || bitLength === 32) {
            const buf = new Uint8Array(bitLength / 8);
            for (let i = 0; i < buf.length; i++) {
                buf[i] = this.readBits(offset + 8 * i, 8); // NaN coerces to 0, like the string version
            }
            const dv = new DataView(buf.buffer);
            return bitLength === 16 ? dv.getUint16(0, littleEndian) : dv.getUint32(0, littleEndian);
        }
        throw new Error('Invalid BitWord size');
    }
}
