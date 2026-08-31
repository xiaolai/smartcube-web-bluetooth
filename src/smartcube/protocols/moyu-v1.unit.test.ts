import { describe, it, expect, vi } from 'vitest';
import {
  MOYU_V1_SOLVED_STICKERS,
  MoyuV1Client,
  moyuStickersToFaceletString,
  moyuV1EncodeCubeStatePayload,
  moyuV1ParseCubeStatePayload,
} from './moyu-v1';

function dvFromBytes(bytes: number[]): DataView {
  return new DataView(Uint8Array.from(bytes).buffer);
}

describe('moyu-v1 helpers', () => {
  it('round-trips cube state payload encode/parse', () => {
    const stickers = MOYU_V1_SOLVED_STICKERS.map((r) => [...r]);
    const angles = [0, 1, 2, 3, 4, 5];

    const encoded = moyuV1EncodeCubeStatePayload(stickers, angles);
    expect(encoded.byteLength).toBe(30);

    const parsed = moyuV1ParseCubeStatePayload(new DataView(encoded.buffer));
    expect(parsed.stickers).toEqual(stickers);
    expect(parsed.angles).toEqual(angles.map((a) => a & 15));
  });

  it('maps stickers to a 54-char facelet string', () => {
    const facelets = moyuStickersToFaceletString(MOYU_V1_SOLVED_STICKERS);
    expect(facelets).toHaveLength(54);
    // Centers in URFDLB order should be U,R,F,D,L,B.
    expect(facelets[4]).toBe('U');
    expect(facelets[13]).toBe('R');
    expect(facelets[22]).toBe('F');
    expect(facelets[31]).toBe('D');
    expect(facelets[40]).toBe('L');
    expect(facelets[49]).toBe('B');
  });

  it('maps the solved stickers to the exact solved facelet string (bijective cell map)', () => {
    // Pins every cell of MOYU_CELL_TO_STD, not just the centers: a single transposed
    // index (as shipped upstream: 26 in the R row, 29 in the F row) fails this.
    expect(moyuStickersToFaceletString(MOYU_V1_SOLVED_STICKERS)).toBe(
      'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB',
    );
  });

  it('rejects malformed sticker shapes', () => {
    expect(() => moyuStickersToFaceletString([[0, 1, 2]])).toThrow(/6 faces/);
    expect(() => moyuV1EncodeCubeStatePayload([[0]], [0, 0, 0, 0, 0, 0])).toThrow(/6 faces/);
    expect(() =>
      moyuV1EncodeCubeStatePayload(
        MOYU_V1_SOLVED_STICKERS.map((r) => [...r]),
        [0, 0, 0],
      ),
    ).toThrow(/angles/);
  });

  it('rejects a cube-state payload shorter than 30 bytes', () => {
    expect(() => moyuV1ParseCubeStatePayload(new DataView(new ArrayBuffer(10)))).toThrow(/too short/);
  });
});

describe('MoyuV1Client.send', () => {
  it('rejects immediately and leaves no waiter or timer when the GATT write fails', async () => {
    vi.useFakeTimers();
    try {
      // No `.service` on the characteristic: the write path throws before anything is sent.
      const client = new MoyuV1Client({} as BluetoothRemoteGATTCharacteristic);
      await expect(client.send(3)).rejects.toBeInstanceOf(Error);
      expect((client as any).waiters).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a body needing 16 frames (the 4-bit total field holds at most 15)', async () => {
    const client = new MoyuV1Client({} as BluetoothRemoteGATTCharacteristic);
    // 1 header byte + 18*15 payload bytes = 271 = 16 parts; 16 << 4 would truncate to 0.
    await expect(client.send(3, new Uint8Array(18 * 15))).rejects.toThrow(/Too many parts/);
  });

  it('rejects out-of-range command codes before touching the wire', async () => {
    const client = new MoyuV1Client({} as BluetoothRemoteGATTCharacteristic);
    await expect(client.send(16)).rejects.toThrow(/out of range/);
    await expect(client.send(-1)).rejects.toThrow(/out of range/);
  });
});

describe('MoyuV1Client.dispose', () => {
  it('rejects pending waiters and clears fragment state', async () => {
    vi.useFakeTimers();
    try {
      const client = new MoyuV1Client({} as BluetoothRemoteGATTCharacteristic);
      const rejections: Error[] = [];
      const timeout = setTimeout(() => {}, 10_000);
      (client as any).waiters.push({
        command: 3,
        id: 1,
        sentAt: 0,
        resolve: () => {},
        reject: (e: Error) => rejections.push(e),
        timeout,
      });
      (client as any).incomplete.push({ index: 0, total: 2, payload: new Uint8Array(1) });
      client.dispose();
      expect(rejections).toHaveLength(1);
      expect(rejections[0]!.message).toMatch(/disposed/);
      expect((client as any).waiters).toHaveLength(0);
      expect((client as any).incomplete).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MoyuV1Client.onReadNotification', () => {
  it('ignores a final part that merges to an empty payload instead of throwing', () => {
    const client = new MoyuV1Client({} as BluetoothRemoteGATTCharacteristic);
    // total=1, index=0 and no payload bytes: nothing to parse.
    expect(() => client.onReadNotification(dvFromBytes([0x00, (1 << 4) | 0]))).not.toThrow();
  });

  it('resolves a matching waiter when the final part arrives', async () => {
    vi.useFakeTimers();
    const client = new MoyuV1Client({} as BluetoothRemoteGATTCharacteristic);

    const resolved: { value: DataView }[] = [];
    const timeout = setTimeout(() => {}, 10_000);
    (client as any).waiters.push({
      command: 3,
      id: 1,
      sentAt: 123,
      resolve: (v: { sentAt: number; receivedAt: number; value: DataView }) => resolved.push({ value: v.value }),
      reject: () => {},
      timeout,
    });

    // Build a merged response payload:
    // header: command=3, success=1, id=1 => 3 | (1<<4) | (1<<5) = 51
    const merged = [51, 0xaa, 0xbb, 0xcc];
    // split across 2 parts (payload is everything after byte2 in each 20-byte frame)
    const part0 = [0x00, (2 << 4) | 0, ...merged.slice(0, 2)];
    const part1 = [0x00, (2 << 4) | 1, ...merged.slice(2)];

    client.onReadNotification(dvFromBytes(part0));
    expect(resolved.length).toBe(0);
    client.onReadNotification(dvFromBytes(part1));

    expect(resolved.length).toBe(1);
    const out = resolved[0]!.value;
    expect(out.byteLength).toBe(3);
    expect(out.getUint8(0)).toBe(0xaa);
    expect(out.getUint8(1)).toBe(0xbb);
    expect(out.getUint8(2)).toBe(0xcc);

    clearTimeout(timeout);
    vi.useRealTimers();
  });

  it('does not let a malformed total=0 frame poison the next response', () => {
    const client = new MoyuV1Client({} as BluetoothRemoteGATTCharacteristic);
    const resolved: DataView[] = [];
    const timeout = setTimeout(() => {}, 10_000);
    (client as any).waiters.push({
      command: 3,
      id: 1,
      sentAt: 0,
      resolve: (v: { value: DataView }) => resolved.push(v.value),
      reject: () => {},
      timeout,
    });

    // Poison frame: total=0, index=0, one payload byte. Must be dropped, not retained.
    client.onReadNotification(dvFromBytes([0x00, 0x00, 0x99]));
    // Real single-part response: header 51 = command 3, success, id 1; payload [0xaa].
    client.onReadNotification(dvFromBytes([0x00, (1 << 4) | 0, 51, 0xaa]));

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.byteLength).toBe(1);
    expect(resolved[0]!.getUint8(0)).toBe(0xaa);
    clearTimeout(timeout);
  });

  it('restarts assembly when a part with a different total arrives', () => {
    const client = new MoyuV1Client({} as BluetoothRemoteGATTCharacteristic);
    const resolved: DataView[] = [];
    const timeout = setTimeout(() => {}, 10_000);
    (client as any).waiters.push({
      command: 3,
      id: 1,
      sentAt: 0,
      resolve: (v: { value: DataView }) => resolved.push(v.value),
      reject: () => {},
      timeout,
    });

    // Stale first half of a two-part response that never completed…
    client.onReadNotification(dvFromBytes([0x00, (2 << 4) | 0, 0x11, 0x22]));
    // …followed by a complete single-part response.
    client.onReadNotification(dvFromBytes([0x00, (1 << 4) | 0, 51, 0xbb]));

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.byteLength).toBe(1);
    expect(resolved[0]!.getUint8(0)).toBe(0xbb);
    clearTimeout(timeout);
  });

  it('drops a completed assembly with missing indices instead of merging a gap', () => {
    const client = new MoyuV1Client({} as BluetoothRemoteGATTCharacteristic);
    const resolved: DataView[] = [];
    const timeout = setTimeout(() => {}, 10_000);
    (client as any).waiters.push({
      command: 3,
      id: 1,
      sentAt: 0,
      resolve: (v: { value: DataView }) => resolved.push(v.value),
      reject: () => {},
      timeout,
    });

    // Final part of a 3-part response with parts 0 and 1 missing: must not dispatch.
    client.onReadNotification(dvFromBytes([0x00, (3 << 4) | 2, 51, 0xcc]));
    expect(resolved).toHaveLength(0);
    clearTimeout(timeout);
  });

  it('ignores frames shorter than the two-byte header', () => {
    const client = new MoyuV1Client({} as BluetoothRemoteGATTCharacteristic);
    expect(() => client.onReadNotification(dvFromBytes([0x00]))).not.toThrow();
    expect(() => client.onReadNotification(dvFromBytes([]))).not.toThrow();
  });
});

