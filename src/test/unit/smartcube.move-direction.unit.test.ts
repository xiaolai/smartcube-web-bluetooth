import { describe, it, expect } from 'vitest';
import { moveDirectionFromNotation } from '../../smartcube/cubie-cube';

describe('moveDirectionFromNotation', () => {
  it('maps clockwise, counter-clockwise and half turns to 0, 1, 2', () => {
    expect(moveDirectionFromNotation('R')).toBe(0);
    expect(moveDirectionFromNotation("R'")).toBe(1);
    expect(moveDirectionFromNotation('R2')).toBe(2);
  });

  it('covers every face letter', () => {
    for (const f of 'URFDLB') {
      expect(moveDirectionFromNotation(f)).toBe(0);
      expect(moveDirectionFromNotation(`${f}'`)).toBe(1);
      expect(moveDirectionFromNotation(`${f}2`)).toBe(2);
    }
  });
});
