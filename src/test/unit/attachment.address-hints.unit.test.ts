import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getCachedMacForDevice,
  macFromGanManufacturerData,
  removeCachedMacForDevice,
  setCachedMacForDevice,
  waitForManufacturerData,
} from '../../smartcube/attachment/address-hints';

type AdvDevice = BluetoothDevice & { emitAdvertisement(mf: Map<number, DataView> | null): void };

/** `watch: null` models a browser without watchAdvertisements (the property is absent). */
function advertisingDevice(name: string, watch: (() => Promise<void>) | null = async () => {}): AdvDevice {
  const d = new (class extends EventTarget {
    readonly name = name;
    readonly id = `id-${name}`;
    watchAdvertisements = watch ?? undefined;
    emitAdvertisement(mf: Map<number, DataView> | null): void {
      const evt = new Event('advertisementreceived') as BluetoothAdvertisingEvent;
      (evt as unknown as { manufacturerData: unknown }).manufacturerData = mf;
      this.dispatchEvent(evt);
    }
  })();
  return d as unknown as AdvDevice;
}

function mfWith(id: number, bytes: number[]): Map<number, DataView> {
  return new Map([[id, new DataView(Uint8Array.from(bytes).buffer)]]);
}

describe('waitForManufacturerData', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when watchAdvertisements is not supported', async () => {
    const device = advertisingDevice('GANic', null);
    await expect(waitForManufacturerData(device, 100)).resolves.toBeNull();
  });

  it('keeps listening past an empty first advertisement and returns data from a later one', async () => {
    const device = advertisingDevice('QY-QYSC-S-A0E6');
    const p = waitForManufacturerData(device, 1000);
    device.emitAdvertisement(new Map());
    await vi.advanceTimersByTimeAsync(50);
    device.emitAdvertisement(mfWith(0x0504, [1, 2, 3, 4, 5, 6]));
    const mf = await p;
    expect(mf).not.toBeNull();
    expect(mf!.has(0x0504)).toBe(true);
  });

  it('merges manufacturer data across advertisements', async () => {
    const device = advertisingDevice('GANic');
    const p = waitForManufacturerData(device, 1000);
    device.emitAdvertisement(mfWith(0x0001, [9, 9, 9, 9, 9, 9]));
    const mf = await p;
    expect(mf!.has(0x0001)).toBe(true);
  });

  it('exits early on an empty first advertisement for WCU_ names by default', async () => {
    const device = advertisingDevice('WCU_MY33_AF9E');
    const p = waitForManufacturerData(device, 1000);
    device.emitAdvertisement(new Map());
    await expect(p).resolves.toBeNull();
  });

  it('waits for later advertisements for WCU_ names when early exit is disabled', async () => {
    const device = advertisingDevice('WCU_MY33_AF9E');
    const p = waitForManufacturerData(device, 1000, { earlyExitOnEmptyFirstAdvertisement: false });
    device.emitAdvertisement(new Map());
    await vi.advanceTimersByTimeAsync(50);
    device.emitAdvertisement(mfWith(0x0504, [0x9e, 0xaf, 0x02, 0x16, 0x30, 0xcf]));
    const mf = await p;
    expect(mf).not.toBeNull();
  });

  it('returns null on timeout and ignores a late advertisement', async () => {
    const device = advertisingDevice('GANic');
    const p = waitForManufacturerData(device, 100);
    await vi.advanceTimersByTimeAsync(101);
    await expect(p).resolves.toBeNull();
    device.emitAdvertisement(mfWith(0x0001, [1, 2, 3, 4, 5, 6]));
  });

  it('returns null when watchAdvertisements rejects', async () => {
    const device = advertisingDevice('GANic', async () => {
      throw new Error('nope');
    });
    const p = waitForManufacturerData(device, 100);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeNull();
  });

  it('resolves null immediately when the signal is already aborted', async () => {
    const device = advertisingDevice('GANic');
    const controller = new AbortController();
    controller.abort();
    await expect(waitForManufacturerData(device, 1000, { signal: controller.signal })).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves null when aborted mid-wait and ignores later advertisements', async () => {
    const device = advertisingDevice('GANic');
    const controller = new AbortController();
    const p = waitForManufacturerData(device, 1000, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(p).resolves.toBeNull();
    device.emitAdvertisement(mfWith(0x0001, [1, 2, 3, 4, 5, 6]));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('macFromGanManufacturerData', () => {
  it('reads the MAC from the last 6 bytes of the GAN company-id payload, reversed', () => {
    const mf = mfWith(0x0101, [0, 0, 0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    expect(macFromGanManufacturerData(mf as unknown as BluetoothManufacturerData)).toBe('66:55:44:33:22:11');
  });

  it('returns null when no GAN company id is present or the payload is too short', () => {
    expect(macFromGanManufacturerData(mfWith(0x0504, [1, 2, 3, 4, 5, 6]) as unknown as BluetoothManufacturerData)).toBeNull();
    expect(macFromGanManufacturerData(mfWith(0x0101, [1, 2, 3]) as unknown as BluetoothManufacturerData)).toBeNull();
  });
});

describe('cached MAC per device', () => {
  it('round-trips through localStorage keyed by device id and can be removed', () => {
    const device = advertisingDevice('GANic');
    expect(getCachedMacForDevice(device)).toBeNull();
    setCachedMacForDevice(device, 'AA:BB:CC:DD:EE:FF');
    expect(getCachedMacForDevice(device)).toBe('AA:BB:CC:DD:EE:FF');
    removeCachedMacForDevice(device);
    expect(getCachedMacForDevice(device)).toBeNull();
  });
});
