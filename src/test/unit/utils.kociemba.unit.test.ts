import { describe, it, expect } from 'vitest';
import { toKociembaFacelets } from '../../utils';

const SOLVED_CP = [0, 1, 2, 3, 4, 5, 6, 7];
const SOLVED_CO = [0, 0, 0, 0, 0, 0, 0, 0];
const SOLVED_EP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const SOLVED_EO = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

describe('toKociembaFacelets', () => {
  it('produces the documented solved and F R example strings', () => {
    expect(toKociembaFacelets(SOLVED_CP, SOLVED_CO, SOLVED_EP, SOLVED_EO)).toBe(
      'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB',
    );
    expect(
      toKociembaFacelets(
        [0, 5, 2, 1, 7, 4, 6, 3],
        [1, 2, 0, 2, 1, 1, 0, 2],
        [1, 9, 2, 3, 11, 8, 6, 7, 4, 5, 10, 0],
        [1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0],
      ),
    ).toBe('UUFUUFLLFUUURRRRRRFFRFFDFFDRRBDDBDDBLLDLLDLLDLBBUBBUBB');
  });

  it('rejects malformed cubie arrays loudly instead of emitting garbage facelets', () => {
    expect(() => toKociembaFacelets([0, 0, 2, 3, 4, 5, 6, 7], SOLVED_CO, SOLVED_EP, SOLVED_EO)).toThrow(/cp/);
    expect(() => toKociembaFacelets(SOLVED_CP, [3, 0, 0, 0, 0, 0, 0, 0], SOLVED_EP, SOLVED_EO)).toThrow(/co/);
    expect(() => toKociembaFacelets(SOLVED_CP, SOLVED_CO, [0, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], SOLVED_EO)).toThrow(/ep/);
    expect(() => toKociembaFacelets(SOLVED_CP, SOLVED_CO, SOLVED_EP, [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toThrow(/eo/);
    expect(() => toKociembaFacelets([0, 1, 2], SOLVED_CO, SOLVED_EP, SOLVED_EO)).toThrow(/cp/);
  });

  it('accepts a twisted corner (orientation sum not divisible by 3): structural, not solvability, validation', () => {
    const out = toKociembaFacelets(SOLVED_CP, [1, 0, 0, 0, 0, 0, 0, 0], SOLVED_EP, SOLVED_EO);
    expect(out).toHaveLength(54);
  });
});
