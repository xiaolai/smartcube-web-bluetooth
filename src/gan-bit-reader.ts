/** Big-endian bit-stream reader for decrypted GAN protocol messages. */
export class GanBitReader {
    private readonly bits: string;

    constructor(message: Uint8Array | readonly number[]) {
        this.bits = Array.from(message, (b) => (b + 256).toString(2).slice(1)).join('');
    }

    getBitWord(offset: number, bitLength: number, littleEndian = false): number {
        if (bitLength <= 8) {
            return parseInt(this.bits.slice(offset, offset + bitLength), 2);
        }
        if (bitLength === 16 || bitLength === 32) {
            const buf = new Uint8Array(bitLength / 8);
            for (let i = 0; i < buf.length; i++) {
                buf[i] = parseInt(this.bits.slice(8 * i + offset, 8 * i + offset + 8), 2);
            }
            const dv = new DataView(buf.buffer);
            return bitLength === 16 ? dv.getUint16(0, littleEndian) : dv.getUint32(0, littleEndian);
        }
        throw new Error('Invalid BitWord size');
    }
}
