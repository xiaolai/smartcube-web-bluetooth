import { describe, it, expect } from 'vitest';
import { CubieCube, SOLVED_FACELET } from '../../smartcube/cubie-cube';

describe('CubieCube.fromFacelet', () => {
  it('accepts the solved facelet string', () => {
    const c = new CubieCube();
    expect(c.fromFacelet(SOLVED_FACELET)).not.toBe(-1);
  });

  it('round-trips solved facelets through toFaceCube', () => {
    const c = new CubieCube();
    const out = c.fromFacelet(SOLVED_FACELET);
    expect(out).not.toBe(-1);
    if (out !== -1) {
      expect(out.toFaceCube()).toBe(SOLVED_FACELET);
    }
  });

  it('returns -1 when the input contains characters outside the six center colors', () => {
    const c = new CubieCube();
    const bad = SOLVED_FACELET.slice(0, 10) + 'X' + SOLVED_FACELET.slice(11);
    expect(c.fromFacelet(bad)).toBe(-1);
  });

  it('returns -1 when color counts are invalid', () => {
    const c = new CubieCube();
    // Replace one U with R: still uses valid colors but breaks the 9x-per-face count check.
    const bad = 'R' + SOLVED_FACELET.slice(1);
    expect(c.fromFacelet(bad)).toBe(-1);
  });

  it('returns -1 for any length other than 54 (including empty) instead of throwing', () => {
    const c = new CubieCube();
    expect(c.fromFacelet('')).toBe(-1);
    expect(c.fromFacelet(SOLVED_FACELET.slice(0, 53))).toBe(-1);
    expect(c.fromFacelet(SOLVED_FACELET + 'U')).toBe(-1);
  });

  it('returns -1 for a count-balanced state with an impossible corner (corner/edge sticker swap)', () => {
    const c = new CubieCube();
    // Swap the R sticker of the URF corner (index 9) with the F sticker of the UF edge
    // (index 19): color counts stay 9-per-face, but URF becomes the impossible (U,F,F).
    const chars = SOLVED_FACELET.split('');
    [chars[9], chars[19]] = [chars[19]!, chars[9]!];
    expect(c.fromFacelet(chars.join(''))).toBe(-1);
  });

  it('does not mutate the cube when rejecting an invalid facelet string', () => {
    const c = new CubieCube();
    const scrambled = new CubieCube();
    CubieCube.CubeMult(new CubieCube(), CubieCube.moveCube[3]!, scrambled); // R
    expect(c.fromFacelet(scrambled.toFaceCube())).not.toBe(-1);
    const before = c.toFaceCube();
    const chars = SOLVED_FACELET.split('');
    [chars[9], chars[19]] = [chars[19]!, chars[9]!];
    expect(c.fromFacelet(chars.join(''))).toBe(-1);
    expect(c.toFaceCube()).toBe(before);
  });

  it('round-trips a legally scrambled state', () => {
    const scrambled = new CubieCube();
    CubieCube.CubeMult(new CubieCube(), CubieCube.moveCube[6]!, scrambled); // F
    const facelets = scrambled.toFaceCube();
    const parsed = new CubieCube().fromFacelet(facelets);
    expect(parsed).not.toBe(-1);
    if (parsed !== -1) {
      expect(parsed.toFaceCube()).toBe(facelets);
      expect(parsed.isSolvable()).toBe(true);
    }
  });
});

describe('CubieCube.isSolvable', () => {
  it('accepts a single twisted corner in fromFacelet but reports it unsolvable', () => {
    // Rotate the URF corner stickers in place: a real state after a corner twist/pop.
    const chars = SOLVED_FACELET.split('');
    const [a, b, d] = [chars[8]!, chars[9]!, chars[20]!];
    chars[8] = d;
    chars[9] = a;
    chars[20] = b;
    const parsed = new CubieCube().fromFacelet(chars.join(''));
    expect(parsed).not.toBe(-1);
    if (parsed !== -1) {
      expect(parsed.isSolvable()).toBe(false);
    }
  });

  it('reports a two-corner swap (odd corner parity) as unsolvable', () => {
    // Swap the URF and UBR pieces: bijective, but corner parity is odd while edge parity is even.
    const chars = SOLVED_FACELET.split('');
    const urf = [8, 9, 20];
    const ubr = [2, 45, 11];
    for (let i = 0; i < 3; i++) {
      [chars[urf[i]!], chars[ubr[i]!]] = [chars[ubr[i]!]!, chars[urf[i]!]!];
    }
    const parsed = new CubieCube().fromFacelet(chars.join(''));
    expect(parsed).not.toBe(-1);
    if (parsed !== -1) {
      expect(parsed.isSolvable()).toBe(false);
    }
  });

  it('reports the solved state as solvable', () => {
    const parsed = new CubieCube().fromFacelet(SOLVED_FACELET);
    expect(parsed).not.toBe(-1);
    if (parsed !== -1) {
      expect(parsed.isSolvable()).toBe(true);
    }
  });
});

describe('CubieCube multiplication aliasing guard', () => {
  it('throws when prod aliases an input instead of silently corrupting it', () => {
    const a = new CubieCube();
    const b = new CubieCube();
    expect(() => CubieCube.CubeMult(a, b, a)).toThrow(/distinct instance/);
    expect(() => CubieCube.CubeMult(a, b, b)).toThrow(/distinct instance/);
  });
});

