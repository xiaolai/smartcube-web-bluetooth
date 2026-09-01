import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Subject } from 'rxjs';
import { connectSmartCube } from './connect';
import { registerProtocol, getRegisteredProtocols, unregisterProtocol, type SmartCubeProtocol } from './protocol';
import type { MacAddressProvider, SmartCubeCapabilities, SmartCubeCommand, SmartCubeConnection, SmartCubeEvent, SmartCubeSnapshot } from './types';
import { getCachedMacForDevice, setCachedMacForDevice } from './attachment/address-hints';
import { isAbortError } from './attachment/abort';

/**
 * The stage after a driver connects: connectSmartCube asks the cube for a fresh report, waits
 * for an event that proves the key is right, and only then caches the MAC. A wrong key must
 * never be persisted; a cancelled connect must tear the connection down through the driver.
 */

const MAC = 'AA:BB:CC:DD:EE:FF';
const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
/** Fifty-four legal letters that are not a cube: what a wrong MoYu/QiYi key decrypts to. */
const NOT_A_CUBE = 'U'.repeat(54);
const VERIFY_TIMEOUT_MS = 10_000;

const ALL_OFF: SmartCubeCapabilities = { gyroscope: false, battery: false, facelets: false, hardware: false, reset: false };

type FakeConnection = SmartCubeConnection & {
  events$: Subject<SmartCubeEvent>;
  sendCommand: ReturnType<typeof vi.fn<(c: SmartCubeCommand) => Promise<void>>>;
  disconnect: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

function fakeConnection(opts: {
  mac?: string;
  capabilities?: Partial<SmartCubeCapabilities>;
  onCommand?: (cmd: SmartCubeCommand, events$: Subject<SmartCubeEvent>) => void | Promise<void>;
}): FakeConnection {
  const events$ = new Subject<SmartCubeEvent>();
  const capabilities = { ...ALL_OFF, ...opts.capabilities };
  const conn: FakeConnection = {
    deviceName: 'Fake',
    deviceMAC: opts.mac ?? MAC,
    protocol: { id: 'fake', name: 'Fake' },
    capabilities,
    events$,
    state$: new Subject<SmartCubeSnapshot>(),
    getSnapshot: () => ({ revision: 0, connected: true, facelets: null, battery: null, hardware: null, capabilities }),
    sendCommand: vi.fn(async (cmd: SmartCubeCommand) => {
      await opts.onCommand?.(cmd, events$);
    }),
    disconnect: vi.fn(async () => {
      events$.complete();
    }),
  };
  return conn;
}

type Device = BluetoothDevice & { gattDisconnect: ReturnType<typeof vi.fn> };

function installDevice(opts: { name?: string; watchAdvertisements?: boolean; gattDisconnectThrows?: boolean } = {}): Device {
  const gattDisconnect = vi.fn(() => {
    if (opts.gattDisconnectThrows) throw new Error('disconnect exploded');
    gatt.connected = false;
  });
  const gatt = {
    connected: false,
    connect: async () => {
      gatt.connected = true;
      return gatt;
    },
    getPrimaryServices: async () => [{ uuid: '0000fff0-0000-1000-8000-00805f9b34fb' }],
    disconnect: gattDisconnect,
  };
  const device = new (class extends EventTarget {
    readonly name = opts.name ?? 'Fake Cube';
    readonly id = 'verify-device';
    gatt = gatt;
    gattDisconnect = gattDisconnect;
    /** Present but never advertising: the pre-connect wait runs its full budget. */
    watchAdvertisements = opts.watchAdvertisements ? async (): Promise<void> => {} : undefined;
  })();
  (globalThis as unknown as { navigator: { bluetooth: unknown } }).navigator.bluetooth = { requestDevice: async () => device };
  return device as unknown as Device;
}

function protocolWith(conn: SmartCubeConnection | (() => Promise<SmartCubeConnection>), over: Partial<SmartCubeProtocol> = {}): SmartCubeProtocol {
  return {
    nameFilters: [{ namePrefix: 'Fake' }],
    optionalServices: [],
    matchesDevice: () => true,
    gattAffinity: () => 500,
    connect: typeof conn === 'function' ? conn : async () => conn,
    ...over,
  };
}

let previousRegistry: SmartCubeProtocol[] = [];

describe('connectSmartCube: MAC verification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    previousRegistry = getRegisteredProtocols();
    for (const p of previousRegistry) unregisterProtocol(p);
  });
  afterEach(() => {
    for (const p of getRegisteredProtocols()) unregisterProtocol(p);
    for (const p of previousRegistry) registerProtocol(p);
    vi.useRealTimers();
  });

  it('asks for facelets, accepts a legal cube state as proof, and only then caches the MAC', async () => {
    const device = installDevice();
    const conn = fakeConnection({
      capabilities: { facelets: true },
      onCommand: (cmd, events$) => {
        if (cmd.type === 'REQUEST_FACELETS') events$.next({ timestamp: 1, type: 'FACELETS', facelets: SOLVED });
      },
    });
    registerProtocol(protocolWith(conn));
    const status: string[] = [];

    const result = await connectSmartCube({ onStatus: (m) => status.push(m) });

    expect(result).toBe(conn);
    expect(conn.sendCommand).toHaveBeenCalledWith({ type: 'REQUEST_FACELETS' });
    expect(getCachedMacForDevice(device)).toBe(MAC);
    expect(status).toEqual(['Select your cube…', 'Connecting…', 'Verifying connection…']);
    expect(conn.disconnect).not.toHaveBeenCalled();
  });

  it('does not accept facelets that are not a legal cube (a wrong key still decodes to letters): times out, forgets the MAC, disconnects through the driver', async () => {
    const device = installDevice();
    setCachedMacForDevice(device, MAC); // a stale cache entry from an earlier session
    const conn = fakeConnection({
      capabilities: { facelets: true },
      onCommand: (_cmd, events$) => events$.next({ timestamp: 1, type: 'FACELETS', facelets: NOT_A_CUBE }),
    });
    registerProtocol(protocolWith(conn));

    const p = connectSmartCube();
    const expectation = expect(p).rejects.toThrow('Timed out waiting for cube data. Check the Bluetooth MAC address and try again.');
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS + 1);
    await expectation;

    expect(getCachedMacForDevice(device)).toBeNull();
    expect(conn.disconnect).toHaveBeenCalledTimes(1);
    expect(device.gattDisconnect).not.toHaveBeenCalled(); // teardown went through the driver
  });

  it.each([
    ['hardware', { hardware: true }, 'REQUEST_HARDWARE', { type: 'HARDWARE' as const }],
    ['battery', { battery: true }, 'REQUEST_BATTERY', { type: 'BATTERY' as const, batteryLevel: 50 }],
  ])('for a cube without facelets, asks for %s and accepts that report as proof', async (_label, caps, request, proof) => {
    const device = installDevice();
    const conn = fakeConnection({
      capabilities: caps,
      onCommand: (cmd, events$) => {
        if (cmd.type === request) events$.next({ timestamp: 1, ...proof });
      },
    });
    registerProtocol(protocolWith(conn));

    await expect(connectSmartCube()).resolves.toBe(conn);
    expect(conn.sendCommand).toHaveBeenCalledTimes(1);
    expect(conn.sendCommand).toHaveBeenCalledWith({ type: request });
    expect(getCachedMacForDevice(device)).toBe(MAC);
  });

  it('sends nothing when the cube can report neither facelets, hardware nor battery, but still waits for spontaneous proof', async () => {
    const device = installDevice();
    const conn = fakeConnection({});
    registerProtocol(protocolWith(conn));

    const p = connectSmartCube();
    await vi.advanceTimersByTimeAsync(50);
    expect(conn.sendCommand).not.toHaveBeenCalled();
    conn.events$.next({ timestamp: 1, type: 'BATTERY', batteryLevel: 90 });
    await expect(p).resolves.toBe(conn);
    expect(getCachedMacForDevice(device)).toBe(MAC);
  });

  it('reports a failed refresh command instead of a misleading timeout', async () => {
    const device = installDevice();
    const conn = fakeConnection({
      capabilities: { facelets: true },
      onCommand: () => {
        throw new Error('GATT write failed');
      },
    });
    registerProtocol(protocolWith(conn));

    const p = connectSmartCube();
    const expectation = expect(p).rejects.toThrow('GATT write failed');
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS + 1);
    await expectation;
    expect(getCachedMacForDevice(device)).toBeNull();
    expect(conn.disconnect).toHaveBeenCalledTimes(1);
  });

  it('propagates a driver stream error as-is and forgets the MAC', async () => {
    const device = installDevice();
    setCachedMacForDevice(device, MAC);
    const conn = fakeConnection({
      capabilities: { facelets: true },
      onCommand: (_cmd, events$) => events$.error(new Error('stream broke')),
    });
    registerProtocol(protocolWith(conn));

    await expect(connectSmartCube()).rejects.toThrow('stream broke');
    expect(getCachedMacForDevice(device)).toBeNull();
    expect(conn.disconnect).toHaveBeenCalledTimes(1);
  });

  it('fails at once, not after the timeout, when the connection closes before any proof', async () => {
    const device = installDevice();
    const conn = fakeConnection({
      capabilities: { facelets: true },
      onCommand: (_cmd, events$) => events$.complete(), // the cube dropped the link
    });
    registerProtocol(protocolWith(conn));

    const started = Date.now();
    await expect(connectSmartCube()).rejects.toThrow('Connection closed before cube data could be verified');
    expect(Date.now() - started).toBeLessThan(VERIFY_TIMEOUT_MS);
    expect(getCachedMacForDevice(device)).toBeNull();
  });

  it('aborted during verification: rejects with AbortError, keeps any cached MAC, and disconnects through the driver', async () => {
    const device = installDevice();
    setCachedMacForDevice(device, MAC); // nothing was proven wrong: the cache must survive an abort
    const controller = new AbortController();
    const conn = fakeConnection({
      capabilities: { facelets: true },
      onCommand: () => controller.abort(), // fires while the proof wait is pending
    });
    registerProtocol(protocolWith(conn));

    await expect(connectSmartCube({ signal: controller.signal })).rejects.toSatisfy(isAbortError);
    expect(getCachedMacForDevice(device)).toBe(MAC);
    expect(conn.disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0); // the verify timeout was cleared
  });

  it('an abort that races the driver connect tears the finished connection down instead of returning it', async () => {
    const device = installDevice();
    const controller = new AbortController();
    const conn = fakeConnection({ capabilities: { facelets: true } });
    registerProtocol(
      protocolWith(async () => {
        controller.abort(); // after every pre-connect abort check, before connect() resolves
        return conn;
      })
    );

    await expect(connectSmartCube({ signal: controller.signal })).rejects.toSatisfy(isAbortError);
    expect(conn.disconnect).toHaveBeenCalledTimes(1);
    expect(conn.sendCommand).not.toHaveBeenCalled(); // verification never started
    expect(getCachedMacForDevice(device)).toBeNull();
  });

  it('skips verification entirely for a driver that reports no MAC', async () => {
    const device = installDevice();
    const conn = fakeConnection({ mac: '', capabilities: { facelets: true } });
    registerProtocol(protocolWith(conn));
    await expect(connectSmartCube()).resolves.toBe(conn);
    expect(conn.sendCommand).not.toHaveBeenCalled();
    expect(getCachedMacForDevice(device)).toBeNull();
  });
});

describe('connectSmartCube: options and selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    previousRegistry = getRegisteredProtocols();
    for (const p of previousRegistry) unregisterProtocol(p);
  });
  afterEach(() => {
    for (const p of getRegisteredProtocols()) unregisterProtocol(p);
    for (const p of previousRegistry) registerProtocol(p);
    vi.useRealTimers();
  });

  it('accepts the legacy bare MAC-provider argument and hands it to the driver', async () => {
    installDevice();
    const conn = fakeConnection({ mac: '' });
    const connect = vi.fn<SmartCubeProtocol['connect']>(async () => conn);
    registerProtocol(protocolWith(conn, { connect }));
    const provider: MacAddressProvider = async () => MAC;

    await expect(connectSmartCube(provider)).resolves.toBe(conn);
    expect(connect.mock.calls[0]![1]).toBe(provider);
  });

  it('rejects, and releases GATT, when no registered protocol claims the device', async () => {
    const device = installDevice();
    registerProtocol(protocolWith(fakeConnection({}), { matchesDevice: () => false, gattAffinity: () => 0 }));

    await expect(connectSmartCube()).rejects.toThrow("Selected device doesn't match any registered smartcube protocol");
    expect(device.gattDisconnect).toHaveBeenCalled();
  });

  it('waits for advertisements when the device name is unrecognised, since the right driver might need a MAC', async () => {
    installDevice({ watchAdvertisements: true });
    const conn = fakeConnection({ mac: '' });
    registerProtocol(protocolWith(conn, { matchesDevice: () => false }));

    const p = connectSmartCube();
    let settled = false;
    p.then(() => (settled = true), () => (settled = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(p).resolves.toBe(conn);
  });

  it('a throwing onStatus callback is not a connect failure', async () => {
    installDevice();
    const conn = fakeConnection({ mac: '' });
    registerProtocol(protocolWith(conn));
    const onStatus = vi.fn(() => {
      throw new Error('UI is broken');
    });
    await expect(connectSmartCube({ onStatus })).resolves.toBe(conn);
    expect(onStatus).toHaveBeenCalled();
  });

  it('reports the driver failure even when releasing GATT afterwards throws', async () => {
    const device = installDevice({ gattDisconnectThrows: true });
    registerProtocol(
      protocolWith(async () => {
        throw new Error('driver init failed');
      })
    );
    await expect(connectSmartCube()).rejects.toThrow('driver init failed');
    expect(device.gattDisconnect).toHaveBeenCalled();
  });
});
