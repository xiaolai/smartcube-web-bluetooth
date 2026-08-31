import { describe, it, expect } from 'vitest';
import { isValidMoYu32DecryptedPacket, isValidQiYiDecryptedPacket } from '../../smartcube/attachment/packet-sanity';
import { crc16modbus } from '../../smartcube/attachment/qiyi-wire';

describe('isValidMoYu32DecryptedPacket', () => {
  it('returns false when payload is missing or too short', () => {
    expect(isValidMoYu32DecryptedPacket(undefined as any)).toBe(false);
    expect(isValidMoYu32DecryptedPacket([])).toBe(false);
    expect(isValidMoYu32DecryptedPacket(new Array(19).fill(1))).toBe(false);
  });

  it('returns false when any byte is outside 0..255', () => {
    const bytes = new Array(20).fill(1);
    bytes[3] = 256;
    expect(isValidMoYu32DecryptedPacket(bytes)).toBe(false);
  });

  it('returns false when there are too many zeros in the first 20 bytes', () => {
    const bytes = new Array(20).fill(0);
    bytes[0] = 161;
    // z = 19 (>14) => reject early
    expect(isValidMoYu32DecryptedPacket(bytes)).toBe(false);
  });

  it('returns false when there are too many unique values in the first 20 bytes', () => {
    const bytes = Array.from({ length: 20 }, (_, i) => i);
    // unique size = 20 (>18) => reject early
    expect(isValidMoYu32DecryptedPacket(bytes)).toBe(false);
  });

  it('returns true for a minimal type 161 payload with a valid ASCII field', () => {
    // First byte is the packet type (161 / 0xA1). Next 8 bytes are an ASCII field.
    // Keep first 20 bytes with limited unique values and no excessive zeros/255.
    const bytes = new Array<number>(20).fill(1);
    bytes[0] = 0xa1;
    const ascii = 'ABCDEFGH';
    for (let i = 0; i < 8; i++) {
      bytes[1 + i] = ascii.charCodeAt(i);
    }
    expect(isValidMoYu32DecryptedPacket(bytes)).toBe(true);
  });

  it('accepts a genuine battery packet (level byte + zero padding)', () => {
    const bytes = new Array<number>(20).fill(0);
    bytes[0] = 164;
    bytes[1] = 55;
    // The old generic entropy screen rejected this real packet shape (18 zero bytes).
    expect(isValidMoYu32DecryptedPacket(bytes)).toBe(true);
  });

  it('rejects battery packets with an impossible level or nonzero padding', () => {
    const overLevel = new Array<number>(20).fill(0);
    overLevel[0] = 164;
    overLevel[1] = 101;
    expect(isValidMoYu32DecryptedPacket(overLevel)).toBe(false);
    const dirtyTail = new Array<number>(20).fill(0);
    dirtyTail[0] = 164;
    dirtyTail[1] = 55;
    dirtyTail[19] = 7;
    expect(isValidMoYu32DecryptedPacket(dirtyTail)).toBe(false);
  });

  function bitsToBytes(bits: string): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
      bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    return bytes;
  }

  it('accepts a facelets packet whose body decodes to a structurally valid cube state', () => {
    // Solved cube: face block k (source order FBUDLR) is eight 3-bit stickers of color k.
    let body = '';
    for (let k = 0; k < 6; k++) {
      body += k.toString(2).padStart(3, '0').repeat(8);
    }
    const bits = (163).toString(2).padStart(8, '0') + body + '00000001';
    expect(isValidMoYu32DecryptedPacket(bitsToBytes(bits))).toBe(true);
  });

  it('rejects a bit-balanced facelets body that is not a valid cube state', () => {
    // '01' repeated is balanced (the old screen accepted it) but decodes to garbage colors.
    const body = '01'.repeat(72);
    const bits = (163).toString(2).padStart(8, '0') + body + '00000001';
    expect(isValidMoYu32DecryptedPacket(bitsToBytes(bits))).toBe(false);
  });

  it('validates each move against its own timestamp slot, not the first N slots', () => {
    // Slot 0 is filler; the single real move sits in slot 1 with a plausible timestamp.
    // The old code read slot 0's timestamp (zero) and wrongly rejected the packet.
    const ts = ['0'.repeat(16), (500).toString(2).padStart(16, '0'), '0'.repeat(16), '0'.repeat(16), '0'.repeat(16)];
    const codes = [31, 3, 31, 31, 31].map((c) => c.toString(2).padStart(5, '0'));
    // opcode(8) + timestamps(80) + move counter(8) + codes(25) + padding(39) = 160 bits
    const bits = (165).toString(2).padStart(8, '0') + ts.join('') + '0'.repeat(8) + codes.join('') + '0'.repeat(39);
    expect(isValidMoYu32DecryptedPacket(bitsToBytes(bits))).toBe(true);
  });
});


describe('isValidQiYiDecryptedPacket', () => {
  /** Build a plaintext QiYi frame exactly as the wire codec does (magic, len, CRC, padding). */
  function qiyiFrame(content: number[]): Uint8Array {
    const msg = [0xfe, 4 + content.length, ...content];
    const crc = crc16modbus(msg);
    msg.push(crc & 0xff, crc >> 8);
    while (msg.length % 16 !== 0) {
      msg.push(0);
    }
    return Uint8Array.from(msg);
  }

  it('accepts a CRC-valid hello response (opcode 0x2)', () => {
    expect(isValidQiYiDecryptedPacket(qiyiFrame([0x02, 0, 0, 0, 1, 9, 9, 9]))).toBe(true);
  });

  it('accepts a hello response with a zero device timestamp (wraparound/boot is legitimate)', () => {
    expect(isValidQiYiDecryptedPacket(qiyiFrame([0x02, 0, 0, 0, 0]))).toBe(true);
  });

  it('rejects a CRC-valid state-change packet: fixed-key traffic proves nothing about the candidate', () => {
    expect(isValidQiYiDecryptedPacket(qiyiFrame([0x03, 0, 0, 0, 1, 9, 9, 9]))).toBe(false);
  });

  it('rejects quaternion packets: gyro streaming is candidate-independent', () => {
    const e = new Uint8Array(16);
    e[0] = 204;
    e[1] = 16;
    expect(isValidQiYiDecryptedPacket(e)).toBe(false);
  });

  it('rejects a hello frame with a corrupt CRC', () => {
    const frame = qiyiFrame([0x02, 0, 0, 0, 1]);
    frame[3] ^= 0xff;
    expect(isValidQiYiDecryptedPacket(frame)).toBe(false);
  });

  it('rejects a truncated frame whose declared length exceeds the payload', () => {
    const frame = qiyiFrame([0x02, 0, 0, 0, 1]);
    expect(isValidQiYiDecryptedPacket(frame.subarray(0, 8))).toBe(false);
  });

  it('rejects payloads that are too short or lack the magic byte', () => {
    expect(isValidQiYiDecryptedPacket(new Uint8Array([254, 1, 2, 3, 4, 5]))).toBe(false);
    expect(isValidQiYiDecryptedPacket(qiyiFrame([0x02]).map((b, i) => (i === 0 ? 0xfd : b)))).toBe(false);
  });
});
