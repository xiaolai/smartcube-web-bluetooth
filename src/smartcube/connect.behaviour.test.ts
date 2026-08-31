import { describe, it, expect, vi } from 'vitest';
import { Subject } from 'rxjs';
import { connectSmartCube } from './connect';
import { registerProtocol, getRegisteredProtocols, unregisterProtocol, type SmartCubeProtocol } from './protocol';
import type { SmartCubeConnection, SmartCubeEvent, SmartCubeSnapshot } from './types';

function swapRegistry(): SmartCubeProtocol[] {
  const snapshot = getRegisteredProtocols();
  for (const p of snapshot) {
    unregisterProtocol(p);
  }
  return snapshot;
}

function restoreRegistry(prev: SmartCubeProtocol[]): void {
  // Remove anything a test registered, then reinstate the previous set.
  for (const p of getRegisteredProtocols()) {
    unregisterProtocol(p);
  }
  for (const p of prev) {
    registerProtocol(p);
  }
}

function dummyConnection(): SmartCubeConnection {
  const events$ = new Subject<SmartCubeEvent>();
  return {
    deviceName: 'Dummy',
    deviceMAC: '',
    protocol: { id: 'dummy', name: 'Dummy' },
    capabilities: { gyroscope: false, battery: false, facelets: false, hardware: false, reset: false },
    events$,
    state$: new Subject<SmartCubeSnapshot>(),
    getSnapshot: () => ({ revision: 0, connected: true, facelets: null, battery: null, hardware: null, capabilities: { gyroscope: false, battery: false, facelets: false, hardware: false, reset: false } }),
    sendCommand: async () => {},
    disconnect: async () => {
      events$.complete();
    },
  };
}

function dummyProtocol(overrides?: Partial<SmartCubeProtocol>): SmartCubeProtocol {
  return {
    nameFilters: [{ namePrefix: 'Dummy' }],
    optionalServices: [],
    matchesDevice: () => true,
    gattAffinity: () => 999,
    connect: async () => dummyConnection(),
    ...overrides,
  };
}

function installDevice(opts?: { gattConnect?: () => Promise<unknown> }): { gattDisconnect: ReturnType<typeof vi.fn> } {
  const gattDisconnect = vi.fn();
  const gatt: {
    connected: boolean;
    connect: () => Promise<unknown>;
    getPrimaryServices: () => Promise<unknown[]>;
    disconnect: () => void;
  } = {
    connected: false,
    connect:
      opts?.gattConnect ??
      (async () => {
        gatt.connected = true;
        return gatt;
      }),
    getPrimaryServices: async () => [],
    disconnect: gattDisconnect,
  };
  const device = new (class extends EventTarget {
    readonly name = 'Dummy Cube';
    readonly id = 'dummy-id';
    gatt = gatt;
    /** Advertisement watching that never produces an advertisement. */
    watchAdvertisements = async (): Promise<void> => {};
  })();
  (globalThis as unknown as { navigator: { bluetooth: unknown } }).navigator.bluetooth = {
    requestDevice: async () => device,
  };
  return { gattDisconnect };
}

describe('connectSmartCube pre-connect behaviour', () => {
  it('skips the advertisement wait when no matching protocol needs a MAC', async () => {
    vi.useFakeTimers();
    const prev = swapRegistry();
    try {
      registerProtocol(dummyProtocol());
      installDevice();
      const p = connectSmartCube({ deviceSelection: 'any' });
      const guard = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('still waiting for advertisements')), 100)
      );
      const race = Promise.race([p, guard]);
      await vi.advanceTimersByTimeAsync(100);
      await expect(race).resolves.toMatchObject({ deviceName: 'Dummy' });
    } finally {
      restoreRegistry(prev);
      vi.useRealTimers();
    }
  });

  it('still waits for advertisements when a matching protocol needs a MAC', async () => {
    vi.useFakeTimers();
    const prev = swapRegistry();
    try {
      registerProtocol(dummyProtocol({ needsMac: true }));
      installDevice();
      const p = connectSmartCube({ deviceSelection: 'any' });
      let settled = false;
      p.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false); // inside the 2.5 s advertisement pass
      await vi.advanceTimersByTimeAsync(2500);
      await expect(p).resolves.toMatchObject({ deviceName: 'Dummy' });
    } finally {
      restoreRegistry(prev);
      vi.useRealTimers();
    }
  });

  it('rejects with AbortError and disconnects when aborted during GATT connect', async () => {
    vi.useFakeTimers();
    const prev = swapRegistry();
    try {
      registerProtocol(dummyProtocol());
      const { gattDisconnect } = installDevice({ gattConnect: () => new Promise(() => {}) });
      const controller = new AbortController();
      const p = connectSmartCube({ deviceSelection: 'any', signal: controller.signal });
      const expectation = expect(p).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(50);
      controller.abort();
      await expectation;
      expect(gattDisconnect).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      restoreRegistry(prev);
      vi.useRealTimers();
    }
  });
});
