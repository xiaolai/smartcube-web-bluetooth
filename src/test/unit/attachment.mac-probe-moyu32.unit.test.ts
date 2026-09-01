import { describe, it, expect, vi } from 'vitest';
import { probeMoyu32Mac } from '../../smartcube/attachment/mac-probe-moyu32';
import { createMoyu32SessionCrypto } from '../../smartcube/attachment/moyu32-session-crypto';
import { MOYU32_READ_CHARACTERISTIC, MOYU32_WRITE_CHARACTERISTIC } from '../../smartcube/gatt-uuids';

const CUBE_MAC = 'CF:30:16:00:1A:2B';
const OTHER_MAC = 'CF:30:16:02:1A:2B';
const OP_BATTERY = 164;

/** A structurally valid MoYu32 battery frame, encrypted as a cube with `mac` would send it. */
function batteryFrameFrom(mac: string, level = 77): Uint8Array {
  const plain = new Array<number>(20).fill(0);
  plain[0] = OP_BATTERY;
  plain[1] = level;
  return Uint8Array.from(createMoyu32SessionCrypto(mac).encrypt(plain));
}

class MockCharacteristic extends EventTarget {
  readonly properties = { write: true, writeWithoutResponse: false };
  value: DataView | null = null;
  readonly service: { device: object };
  writeValueWithResponse = vi.fn(async (_value: BufferSource) => {});
  startNotifications = vi.fn(async () => this);
  stopNotifications = vi.fn(async () => this);

  constructor(readonly uuid: string, device: object) {
    super();
    this.service = { device };
  }

  notify(bytes: Uint8Array): void {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function cube(opts: { characteristics?: MockCharacteristic[] } = {}): {
  device: BluetoothDevice;
  read: MockCharacteristic;
  write: MockCharacteristic;
} {
  const device = {} as object;
  const read = new MockCharacteristic(MOYU32_READ_CHARACTERISTIC, device);
  const write = new MockCharacteristic(MOYU32_WRITE_CHARACTERISTIC, device);
  const chrcts = opts.characteristics ?? [read, write];
  const gatt = {
    connected: true,
    getPrimaryService: async () => ({ getCharacteristics: async () => chrcts }),
  };
  Object.assign(device, { gatt });
  return { device: device as unknown as BluetoothDevice, read, write };
}

/** Every request the probe writes is answered with `frames` notifications on the read characteristic. */
function answerEachWrite(c: { read: MockCharacteristic; write: MockCharacteristic }, frames: () => Uint8Array[]): void {
  c.write.writeValueWithResponse.mockImplementation(async () => {
    queueMicrotask(() => {
      for (const f of frames()) c.read.notify(f);
    });
  });
}

describe('probeMoyu32Mac', () => {
  it('resolves true once three notifications decrypt to valid frames under the candidate key', async () => {
    const c = cube();
    answerEachWrite(c, () => [batteryFrameFrom(CUBE_MAC)]);

    await expect(probeMoyu32Mac(c.device, CUBE_MAC, { timeoutMs: 2000 })).resolves.toBe(true);
    // The startup burst is sent twice (some firmware only wakes on the second), in the cube's order.
    const opcodes = c.write.writeValueWithResponse.mock.calls.map((call) => {
      const enc = Array.from(new Uint8Array(call[0] as ArrayBuffer));
      return createMoyu32SessionCrypto(CUBE_MAC).decrypt(enc)[0];
    });
    expect(opcodes).toEqual([161, 163, 164, 161, 163, 164]);
    expect(c.read.stopNotifications).toHaveBeenCalledTimes(1);
  });

  it('resolves false for a wrong candidate: the cube keeps talking but nothing decrypts', async () => {
    const c = cube();
    // Two frames per write: nine or more undecodable samples end the probe before the timeout.
    answerEachWrite(c, () => [batteryFrameFrom(CUBE_MAC), batteryFrameFrom(CUBE_MAC)]);

    const started = Date.now();
    await expect(probeMoyu32Mac(c.device, OTHER_MAC, { timeoutMs: 5000 })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(c.read.stopNotifications).toHaveBeenCalledTimes(1);
  });

  it('resolves false at the timeout when the cube stays silent', async () => {
    const c = cube();
    await expect(probeMoyu32Mac(c.device, CUBE_MAC, { timeoutMs: 150 })).resolves.toBe(false);
    expect(c.read.stopNotifications).toHaveBeenCalledTimes(1);
  });

  it('resolves false without a report when the startup burst cannot be written', async () => {
    const c = cube();
    c.write.writeValueWithResponse.mockRejectedValue(new Error('GATT operation failed'));
    await expect(probeMoyu32Mac(c.device, CUBE_MAC, { timeoutMs: 2000 })).resolves.toBe(false);
    expect(c.read.stopNotifications).toHaveBeenCalledTimes(1);
  });

  it('resolves false when the MoYu32 characteristics are missing', async () => {
    const c = cube({ characteristics: [] });
    await expect(probeMoyu32Mac(c.device, CUBE_MAC, { timeoutMs: 100 })).resolves.toBe(false);
    expect(c.write.writeValueWithResponse).not.toHaveBeenCalled();
  });

  it('resolves false when the device has no GATT server', async () => {
    await expect(probeMoyu32Mac({} as BluetoothDevice, CUBE_MAC)).resolves.toBe(false);
  });

  it('stops early when the signal fires and reports false', async () => {
    const c = cube();
    const controller = new AbortController();
    answerEachWrite(c, () => {
      controller.abort();
      return [];
    });
    const started = Date.now();
    await expect(probeMoyu32Mac(c.device, CUBE_MAC, { timeoutMs: 5000, signal: controller.signal })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(c.read.stopNotifications).toHaveBeenCalledTimes(1);
  });
});
