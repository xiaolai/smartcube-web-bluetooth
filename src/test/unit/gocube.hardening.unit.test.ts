import { describe, it, expect, vi } from 'vitest';
import { goCubeProtocol } from '../../smartcube/protocols/gocube';
import type { SmartCubeEvent } from '../../smartcube/types';

const WRITE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const READ = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

/** Frame a GoCube message: 0x2a, declared length (total-2), payload, checksum, CRLF. */
function frame(type: number, payload: number[]): number[] {
  const body = [0x2a, payload.length + 4, type, ...payload];
  const checksum = body.reduce((a, b) => a + b, 0) & 0xff;
  return [...body, checksum, 0x0d, 0x0a];
}

const AXIS_PERM = [5, 2, 0, 3, 1, 4];
const FACE_PERM = [0, 1, 2, 5, 8, 7, 6, 3];
const FACE_OFFSET = [0, 0, 6, 2, 0, 0];
const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

/** Invert the driver's type-2 decode: build the wire payload for a URFDLB facelet string. */
function statePayloadFor(facelets: string): number[] {
  const payload = new Array<number>(60).fill(0);
  for (let a = 0; a < 6; a++) {
    const axis = AXIS_PERM[a]! * 9;
    const aoff = FACE_OFFSET[a]!;
    payload[a * 9] = 'BFUDRL'.indexOf(facelets[axis + 4]!);
    for (let i = 0; i < 8; i++) {
      payload[a * 9 + i + 1] = 'BFUDRL'.indexOf(facelets[axis + FACE_PERM[(i + aoff) % 8]!]!);
    }
  }
  return payload;
}

function solvedStatePayload(): number[] {
  return statePayloadFor(SOLVED);
}

class MockCharacteristic extends EventTarget {
  value: DataView | null = null;
  readonly properties = { write: true, writeWithoutResponse: false };
  readonly service: { device: object };
  onWrite: ((bytes: Uint8Array) => void) | null = null;
  startNotifications = vi.fn(async () => this);
  stopNotifications = vi.fn(async () => this);

  constructor(device: object) {
    super();
    this.service = { device };
  }

  async writeValueWithResponse(value: BufferSource): Promise<void> {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer);
    this.onWrite?.(bytes);
  }

  notify(bytes: number[]): void {
    this.value = new DataView(Uint8Array.from(bytes).buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function mockGoCube(name = 'GoCube_test'): {
  device: BluetoothDevice & EventTarget;
  read: MockCharacteristic;
  write: MockCharacteristic;
} {
  const device = new (class extends EventTarget {
    readonly name = name;
    gatt = {
      connected: true,
      connect: async () => this.gatt,
      disconnect: (): void => {
        this.gatt.connected = false;
      },
      getPrimaryService: async () => service,
    };
  })() as unknown as BluetoothDevice & EventTarget;
  const read = new MockCharacteristic(device);
  const write = new MockCharacteristic(device);
  const service = {
    getCharacteristic: async (uuid: string) => {
      if (uuid === WRITE) return write;
      if (uuid === READ) return read;
      throw new Error(`unexpected characteristic ${uuid}`);
    },
  };
  // Answer every state request with the solved state so init resolves immediately.
  write.onWrite = (bytes) => {
    if (bytes[0] === 51) queueMicrotask(() => read.notify(frame(2, solvedStatePayload())));
  };
  return { device, read, write };
}

describe('gocube frame hardening', () => {
  it('rejects frames whose declared length does not match, and corrupt/undersized frames', async () => {
    const { device, read } = mockGoCube();
    const conn = await goCubeProtocol.connect(device);
    const events: SmartCubeEvent[] = [];
    conn.events$.subscribe((e) => events.push(e));

    const battery = frame(5, [77]);
    const badLength = [...battery];
    badLength[1] = 99; // declared length mismatch
    read.notify(badLength);
    const badChecksum = [...battery];
    badChecksum[4] ^= 0xff;
    read.notify(badChecksum);
    // 6-byte type-5 frame: too short to carry a checksum, must not emit battery
    read.notify([0x2a, 4, 5, 90, 0x0d, 0x0a]);
    // short type-2 state frame with valid framing but truncated payload
    read.notify(frame(2, [0, 1, 2, 3]));
    // odd move payload: the unpaired byte must not decode as a move
    read.notify(frame(1, [0, 2, 4]));
    // out-of-range move code
    read.notify(frame(1, [12 << 1, 0]));

    expect(events).toHaveLength(0);

    read.notify(battery);
    expect(events.map((e) => e.type)).toEqual(['BATTERY']);
    await conn.disconnect();
  });

  it('keeps the tracked state when a type-2 frame decodes to an illegal cube state', async () => {
    const { device, read } = mockGoCube();
    const conn = await goCubeProtocol.connect(device);
    const before = conn.getSnapshot().facelets?.value;
    expect(before).toBeTruthy();

    // Count-balanced but impossible state: a corner/edge sticker swap (URF corner's R
    // sticker with the UF edge's F sticker) that fromFacelet rejects.
    const chars = SOLVED.split('');
    [chars[9], chars[19]] = [chars[19]!, chars[9]!];
    const payload = statePayloadFor(chars.join(''));
    const events: SmartCubeEvent[] = [];
    conn.events$.subscribe((e) => events.push(e));
    read.notify(frame(2, payload));

    expect(events).toHaveLength(0);
    expect(conn.getSnapshot().facelets?.value).toBe(before);
    await conn.disconnect();
  });

  it('emits the initial FACELETS from the answered state request', async () => {
    const { device } = mockGoCube();
    const conn = await goCubeProtocol.connect(device);
    expect(conn.getSnapshot().facelets?.value).toBe(
      'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB',
    );
    await conn.disconnect();
  });

  it('fails connect() promptly when the device disconnects during the initial-state wait', async () => {
    const { device, write } = mockGoCube();
    write.onWrite = (bytes) => {
      if (bytes[0] === 51) queueMicrotask(() => device.dispatchEvent(new Event('gattserverdisconnected')));
    };
    await expect(goCubeProtocol.connect(device)).rejects.toThrow(/disconnected during initialization/);
  });
});
