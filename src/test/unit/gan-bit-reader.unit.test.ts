import { describe, it, expect } from 'vitest';
import { GanBitReader } from '../../gan-bit-reader';

describe('GanBitReader.getBitWord', () => {
  const bytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01]);

  it('reads 16-bit words in both byte orders', () => {
    const r = new GanBitReader(bytes);
    expect(r.getBitWord(0, 16, false)).toBe(0xdead);
    expect(r.getBitWord(0, 16, true)).toBe(0xadde);
  });

  it('reads 32-bit words unsigned in both byte orders', () => {
    const r = new GanBitReader(bytes);
    expect(r.getBitWord(0, 32, false)).toBe(0xdeadbeef); // high bit set: must stay unsigned
    expect(r.getBitWord(0, 32, true)).toBe(0xefbeadde);
  });

  it('zeroes missing bytes in 16/32-bit reads past the end (string-impl parity)', () => {
    const r = new GanBitReader(Uint8Array.from([0xff]));
    expect(r.getBitWord(0, 16, false)).toBe(0xff00);
    expect(r.getBitWord(0, 32, true)).toBe(0x000000ff);
  });

  it('returns NaN for a fully out-of-range read and truncates a partial one', () => {
    const r = new GanBitReader(Uint8Array.from([0b10110000]));
    expect(r.getBitWord(8, 8)).toBeNaN();
    expect(r.getBitWord(4, 8)).toBe(0b0000); // only 4 bits available
  });

  it('rejects negative or fractional offsets loudly', () => {
    const r = new GanBitReader(bytes);
    expect(() => r.getBitWord(-1, 8)).toThrow(RangeError);
    expect(() => r.getBitWord(1.5, 8)).toThrow(RangeError);
  });

  it('rejects unsupported word sizes', () => {
    const r = new GanBitReader(bytes);
    expect(() => r.getBitWord(0, 24)).toThrow(/Invalid BitWord size/);
  });
});
