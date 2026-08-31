import { describe, it, expect } from 'vitest';
import { deriveGen1Key } from '../../gan-gen1';
import { GAN_GEN1_KEYS } from '../../gan-cube-definitions';

function hw(bytes: number[]): DataView {
  return new DataView(Uint8Array.from(bytes).buffer);
}

// Expected values were produced by the previous implementation (LZ-compressed tables decoded
// with lz-string at runtime) before the tables were inlined; they pin byte-for-byte equivalence.
describe('deriveGen1Key', () => {
  it('ships six 16-byte key tables', () => {
    expect(GAN_GEN1_KEYS).toHaveLength(6);
    for (const table of GAN_GEN1_KEYS) {
      expect(table).toHaveLength(16);
    }
  });

  it('salts table 0 with reversed hardware bytes for firmware major 0', () => {
    expect(Array.from(deriveGen1Key(0x010008, hw([1, 2, 3, 4, 5, 6]))!)).toEqual([
      204, 207, 25, 226, 81, 111, 19, 182, 119, 13, 230, 89, 58, 175, 186, 162,
    ]);
  });

  it('selects table 5 for firmware major 5', () => {
    expect(Array.from(deriveGen1Key(0x010508, hw([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]))!)).toEqual([
      0, 50, 5, 210, 65, 203, 34, 40, 81, 5, 8, 49, 130, 2, 33, 6,
    ]);
  });

  it('rejects an unknown firmware major instead of guessing table 0', () => {
    // A wrong key would silently decrypt garbage; failing loud beats a guess.
    const hw = new DataView(Uint8Array.from([1, 2, 3, 4, 5, 6]).buffer);
    expect(deriveGen1Key(0x99 << 8, hw)).toBeNull();
  });

  it('returns null when hardware data is shorter than 6 bytes', () => {
    expect(deriveGen1Key(0x010008, hw([1, 2, 3, 4, 5]))).toBeNull();
  });
});
