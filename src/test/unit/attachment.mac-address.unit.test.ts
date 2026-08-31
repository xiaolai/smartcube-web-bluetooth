import { describe, it, expect } from 'vitest';
import { parseMacBytes } from '../../smartcube/attachment/mac-address';

describe('parseMacBytes', () => {
  it('parses colon, dash and whitespace separated octets in display order', () => {
    expect(parseMacBytes('CF:30:16:02:AF:9E')).toEqual([0xcf, 0x30, 0x16, 0x02, 0xaf, 0x9e]);
    expect(parseMacBytes('cf-30-16-02-af-9e')).toEqual([0xcf, 0x30, 0x16, 0x02, 0xaf, 0x9e]);
    expect(parseMacBytes(' cf 30\t16 02 af 9e ')).toEqual([0xcf, 0x30, 0x16, 0x02, 0xaf, 0x9e]);
  });

  it('accepts single-digit octets', () => {
    expect(parseMacBytes('a:b:c:d:e:f')).toEqual([10, 11, 12, 13, 14, 15]);
  });

  it('throws on the wrong number of octets', () => {
    expect(() => parseMacBytes('')).toThrow(/Invalid MAC address/);
    expect(() => parseMacBytes('aa:bb:cc:dd:ee')).toThrow(/Invalid MAC address/);
    expect(() => parseMacBytes('aa:bb:cc:dd:ee:ff:00')).toThrow(/Invalid MAC address/);
  });

  it('throws on non-hex or out-of-range octets instead of producing NaN', () => {
    expect(() => parseMacBytes('aa:bb:cc:dd:ee:gg')).toThrow(/Invalid MAC address/);
    expect(() => parseMacBytes('aa:bb:cc:dd:ee:100')).toThrow(/Invalid MAC address/);
    expect(() => parseMacBytes('not a mac')).toThrow(/Invalid MAC address/);
  });
});
