import { describe, it, expect, vi } from 'vitest';
import { probeQiYiMac } from '../../smartcube/attachment/mac-probe-qiyi';
import { encryptQiYiMessage } from '../../smartcube/attachment/qiyi-wire';
import { isAbortError } from '../../smartcube/attachment/abort';

const QIYI_CHR = '0000fff6-0000-1000-8000-00805f9b34fb';

class MockCharacteristic extends EventTarget {
  readonly uuid = QIYI_CHR;
  readonly properties = { write: true, writeWithoutResponse: false };
  value: DataView | null = null;
  readonly service: { device: object };
  writeValueWithResponse = vi.fn(async (_value: BufferSource) => {});
  startNotifications = vi.fn(async () => this);
  stopNotifications = vi.fn(async () => this);

  constructor(device: object) {
    super();
    this.service = { device };
  }

  notify(bytes: Uint8Array): void {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function mockDevice(chrct: MockCharacteristic): BluetoothDevice {
  const gatt = {
    connected: true,
    getPrimaryService: async () => ({ getCharacteristics: async () => [chrct] }),
  };
  return { gatt } as unknown as BluetoothDevice;
}

describe('probeQiYiMac', () => {
  it('resolves true when the cube answers the hello handshake', async () => {
    const device = {} as object;
    const chrct = new MockCharacteristic(device);
    // Reply to the first hello write with an encrypted hello response (opcode 0x2).
    chrct.writeValueWithResponse.mockImplementation(async () => {
      queueMicrotask(() => chrct.notify(encryptQiYiMessage([0x02, 0, 0, 0, 1, 9, 9])));
    });

    await expect(probeQiYiMac(mockDevice(chrct), 'AA:BB:CC:DD:EE:FF', { timeoutMs: 500 })).resolves.toBe(true);
    expect(chrct.stopNotifications).toHaveBeenCalled();
  });

  it('resolves false when only candidate-independent traffic arrives, and drains its writes', async () => {
    const device = {} as object;
    const chrct = new MockCharacteristic(device);
    chrct.writeValueWithResponse.mockImplementation(async () => {
      // State-change traffic streams regardless of the candidate MAC.
      queueMicrotask(() => chrct.notify(encryptQiYiMessage([0x03, 0, 0, 0, 1, 9, 9])));
    });

    await expect(probeQiYiMac(mockDevice(chrct), 'AA:BB:CC:DD:EE:FF', { timeoutMs: 120 })).resolves.toBe(false);
    // Teardown must run after the last write settled: notifications stopped exactly once.
    expect(chrct.stopNotifications).toHaveBeenCalledTimes(1);
  });

  it('resolves false on persistent write failure without leaking rejections', async () => {
    const device = {} as object;
    const chrct = new MockCharacteristic(device);
    chrct.writeValueWithResponse.mockRejectedValue(new Error('GATT operation failed'));

    await expect(probeQiYiMac(mockDevice(chrct), 'AA:BB:CC:DD:EE:FF', { timeoutMs: 120 })).resolves.toBe(false);
    expect(chrct.stopNotifications).toHaveBeenCalledTimes(1);
  });

  it('throws AbortError when the signal fires mid-probe', async () => {
    const device = {} as object;
    const chrct = new MockCharacteristic(device);
    const controller = new AbortController();
    chrct.writeValueWithResponse.mockImplementation(async () => {
      controller.abort();
    });

    await probeQiYiMac(mockDevice(chrct), 'AA:BB:CC:DD:EE:FF', {
      timeoutMs: 5000,
      signal: controller.signal,
    }).then(
      () => {
        throw new Error('expected AbortError');
      },
      (e) => {
        expect(isAbortError(e)).toBe(true);
      },
    );
    expect(chrct.stopNotifications).toHaveBeenCalledTimes(1);
  });
});
