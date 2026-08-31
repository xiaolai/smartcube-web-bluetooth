import { describe, it, expect } from 'vitest';
import { createMoyu32SessionCrypto } from '../../smartcube/attachment/moyu32-session-crypto';
import { FIXTURES, loadFixture } from '../fixtures';

describe('moyu32 session crypto', () => {
  it('decrypt(encrypt(x)) is the identity for 20-byte frames', () => {
    const c = createMoyu32SessionCrypto('CF:30:16:02:AF:9E');
    const frame = Array.from({ length: 20 }, (_, i) => (i * 37 + 5) & 0xff);
    expect(c.decrypt(c.encrypt(frame.slice()))).toEqual(frame);
  });

  it('decrypts the first captured MoYu32 notification to a known opcode', async () => {
    const fixture = await loadFixture(FIXTURES.moyu32_my33_noGyro);
    const firstNotify = fixture.traffic.find((e) => e.op === 'notify' && e.data);
    expect(firstNotify?.data).toBeTruthy();
    const bytes = firstNotify!.data!.match(/../g)!.map((h) => parseInt(h, 16));
    const c = createMoyu32SessionCrypto(fixture.device.mac!);
    const dec = c.decrypt(bytes);
    expect([161, 163, 164, 165, 171]).toContain(dec[0]);
  });

  it('throws on a malformed MAC', () => {
    expect(() => createMoyu32SessionCrypto('nope')).toThrow(/Invalid MAC address/);
  });
});
