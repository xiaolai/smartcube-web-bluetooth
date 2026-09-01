import { describe, it, expect, vi } from 'vitest';
import { connectGanCube } from '../../gan-smart-cube';
import type { GanCubeConnection, GanCubeEvent } from '../../gan-cube-protocol';
import type { BluetoothLike } from '../../bluetooth-source';
import { FIXTURES, loadFixture } from '../fixtures';
import { installMockBluetoothFromFixture } from '../bluetooth-mock';
import { fixtureExpectedLastFacelets, fixtureExpectedMoves, lastFacelets, moveDirectionMismatches, moves } from '../helpers/events';
import { gen1Device, GEN1_SOLVED } from '../helpers/gen1-device';

/**
 * The legacy `connectGanCube` API, driven through the fixture replayer. Every command it
 * encrypts is checked byte-for-byte against the recording, so this is also the test that
 * proves the gen2 encrypter against real traffic.
 */

function collect(conn: GanCubeConnection): { events: GanCubeEvent[]; completed: () => boolean; stop: () => void } {
  const events: GanCubeEvent[] = [];
  let done = false;
  const sub = conn.events$.subscribe({ next: (e) => events.push(e), complete: () => (done = true) });
  return { events, completed: () => done, stop: () => sub.unsubscribe() };
}

describe('connectGanCube (legacy API)', () => {
  it('connects a gen2 cube through a MAC provider and replays the recorded session', async () => {
    const fixture = await loadFixture(FIXTURES.ganGen2_small);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'legacy-gen2', maxAutoFlushNotifies: 0 });
    const provider = vi.fn(async () => fixture.device.mac ?? null);

    const conn = await connectGanCube(provider);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith(device, false);
    expect(conn.deviceName).toBe(fixture.device.name);
    expect(conn.deviceMAC).toBe(fixture.device.mac);
    // Long-standing contract: consumers may read the resolved address off the device object.
    expect((device as BluetoothDevice & { mac?: string }).mac).toBe(fixture.device.mac);

    const { events, completed, stop } = collect(conn);
    // The recording's four writes, in order; a wrong ciphertext or order fails inside the replayer.
    await conn.sendCubeCommand({ type: 'REQUEST_FACELETS' });
    await conn.sendCubeCommand({ type: 'REQUEST_BATTERY' });
    await conn.sendCubeCommand({ type: 'REQUEST_HARDWARE' });
    await conn.sendCubeCommand({ type: 'REQUEST_FACELETS' });
    await replayer.drainNotificationsAsync();

    expect(moves(events)).toEqual(fixtureExpectedMoves(fixture));
    expect(lastFacelets(events)).toBe(fixtureExpectedLastFacelets(fixture));
    expect(moveDirectionMismatches(events)).toEqual([]);
    expect(events.filter((e) => e.type === 'HARDWARE')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'BATTERY')).toHaveLength(1);
    expect(replayer.debugCursor().index).toBe(replayer.debugCursor().length);

    await conn.disconnect();
    expect(events.at(-1)?.type).toBe('DISCONNECT');
    expect(completed()).toBe(true);
    expect(device.gatt!.connected).toBe(false);
    stop();
  }, 20_000);

  it('connects a gen1 cube without a MAC and serves the legacy command set', async () => {
    const d = gen1Device();
    const bluetooth: BluetoothLike = { requestDevice: async () => d.device };

    const conn = await connectGanCube(undefined, { bluetooth });
    expect(conn.deviceName).toBe('GAN-TEST');
    expect(conn.deviceMAC).toBe('');

    const { events, completed } = collect(conn);
    await conn.sendCubeCommand({ type: 'REQUEST_FACELETS' });
    expect(events.find((e) => e.type === 'FACELETS')).toMatchObject({ facelets: GEN1_SOLVED });
    await expect(conn.sendCubeCommand({ type: 'REQUEST_HARDWARE' })).rejects.toThrow(/does not support REQUEST_HARDWARE/);

    await conn.disconnect();
    expect(events.at(-1)?.type).toBe('DISCONNECT');
    expect(completed()).toBe(true);
    expect(d.gattDisconnect).toHaveBeenCalled();
  });

  it('asks the provider again as a fallback, then fails and releases GATT when no MAC can be found', async () => {
    const fixture = await loadFixture(FIXTURES.ganGen2_small);
    const { device } = installMockBluetoothFromFixture(fixture, { deviceId: 'legacy-no-mac' });
    const provider = vi.fn(async (_d: BluetoothDevice, _fallback?: boolean): Promise<string | null> => null);

    await expect(connectGanCube(provider)).rejects.toThrow(/Unable to determine cube MAC address/);
    expect(provider.mock.calls.map((c) => c[1])).toEqual([false, true]);
    expect(device.gatt!.connected).toBe(false);
  });

  it('fails and releases GATT when the device is not a GAN cube even though a MAC was supplied', async () => {
    const fixture = await loadFixture(FIXTURES.giiker);
    const { device } = installMockBluetoothFromFixture(fixture, { deviceId: 'legacy-not-gan' });

    await expect(connectGanCube(async () => 'AA:BB:CC:DD:EE:FF')).rejects.toThrow(/wrong or unsupported cube device model/);
    expect(device.gatt!.connected).toBe(false);
  });

  it('rejects a device without a GATT server before touching the provider fallback', async () => {
    const bluetooth: BluetoothLike = { requestDevice: async () => ({ name: 'GAN-nogatt' }) as unknown as BluetoothDevice };
    const provider = vi.fn(async () => null);
    await expect(connectGanCube(provider, { bluetooth })).rejects.toThrow(/does not support GATT/);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
