import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { collectPrimaryServiceUuids } from '../../smartcube/attachment/gatt-snapshot';

function deviceWithGatt(connect: () => Promise<unknown>): BluetoothDevice {
  const gatt = {
    connected: false,
    connect,
    disconnect: () => {},
    getPrimaryServices: async () => [{ uuid: '0000fff0-0000-1000-8000-00805f9b34fb' }, { uuid: '180a' }],
  };
  return { gatt } as unknown as BluetoothDevice;
}

describe('collectPrimaryServiceUuids', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns normalised 128-bit uppercase UUIDs', async () => {
    const device = deviceWithGatt(async () => {});
    const set = await collectPrimaryServiceUuids(device);
    expect([...set]).toEqual([
      '0000FFF0-0000-1000-8000-00805F9B34FB',
      '0000180A-0000-1000-8000-00805F9B34FB',
    ]);
  });

  it('leaves no connect-timeout timer running after a successful connect', async () => {
    const device = deviceWithGatt(async () => {});
    await collectPrimaryServiceUuids(device);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails with a GATT connection timeout when connect() never settles', async () => {
    const device = deviceWithGatt(() => new Promise(() => {}));
    const p = collectPrimaryServiceUuids(device);
    const expectation = expect(p).rejects.toThrow('GATT connection timeout');
    // 3 attempts x 25 s connect timeout, plus retry back-off.
    await vi.advanceTimersByTimeAsync(3 * 25_000 + 1_000);
    await expectation;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with AbortError promptly when aborted during a hung connect', async () => {
    const device = deviceWithGatt(() => new Promise(() => {}));
    const controller = new AbortController();
    const p = collectPrimaryServiceUuids(device, { signal: controller.signal });
    const expectation = expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(50);
    controller.abort();
    await expectation;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('abort during service discovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects promptly and disconnects when aborted during hung getPrimaryServices', async () => {
    let disconnected = 0;
    const gatt = {
      connected: false,
      connect: async () => {},
      disconnect: () => {
        disconnected++;
      },
      getPrimaryServices: () => new Promise(() => {}), // stalls forever
    };
    const device = { gatt } as unknown as BluetoothDevice;
    const controller = new AbortController();
    const p = collectPrimaryServiceUuids(device, { signal: controller.signal });
    const expectation = expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expectation;
    expect(disconnected).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects promptly when aborted during the retry back-off delay', async () => {
    let attempts = 0;
    const gatt = {
      connected: false,
      connect: async () => {
        attempts++;
        throw new Error('transient');
      },
      disconnect: () => {},
      getPrimaryServices: async () => [],
    };
    const device = { gatt } as unknown as BluetoothDevice;
    const controller = new AbortController();
    const p = collectPrimaryServiceUuids(device, { signal: controller.signal });
    const expectation = expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10); // inside the first 150 ms back-off now
    controller.abort();
    await expectation;
    expect(attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
