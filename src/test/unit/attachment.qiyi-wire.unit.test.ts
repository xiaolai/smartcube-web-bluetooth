import { describe, it, expect } from 'vitest';
import { crc16modbus, decryptQiYiBlocks, encryptQiYiMessage, qiyiHelloContent } from '../../smartcube/attachment/qiyi-wire';
import { parseMacBytes } from '../../smartcube/attachment/mac-address';
import { FIXTURES, loadFixture } from '../fixtures';

describe('qiyi wire codec', () => {
  it('frames, pads and roundtrips a message', () => {
    const frame = encryptQiYiMessage([0x01, 0x02, 0x03]);
    expect(frame.length % 16).toBe(0);
    const dec = decryptQiYiBlocks(frame);
    expect(dec[0]).toBe(0xfe);
    expect(dec[1]).toBe(7); // 4 + content length
    // MODBUS property: CRC over the frame including its own CRC bytes is 0.
    expect(crc16modbus(Array.from(dec.subarray(0, dec[1]!)))).toBe(0);
  });

  it('produces byte-identical hello frames to the captured QiYi session', async () => {
    const fixture = await loadFixture(FIXTURES.qiyi);
    const firstWrite = fixture.traffic.find((e) => e.op === 'write' && e.data);
    expect(firstWrite?.data).toBeTruthy();
    const frame = encryptQiYiMessage(qiyiHelloContent(parseMacBytes(fixture.device.mac!)));
    const hex = Array.from(frame)
      .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
      .join('');
    expect(hex).toBe(firstWrite!.data!.toUpperCase());
  });
});
