import { describe, it, expect } from 'vitest';
import { FIXTURES, loadFixture } from '../../test/fixtures';
import { installMockBluetoothFromFixture } from '../../test/bluetooth-mock';
import { attachmentContextFor, serviceUuidsFromFixture } from '../../test/helpers/fixture-replay';
import { collectEvents, fixtureExpectedLastFacelets, fixtureExpectedMoves, lastFacelets, moveDirectionMismatches, moves } from '../../test/helpers/events';
import { moyu32Protocol } from './moyu32';

describe('moyu32Protocol.connect (MAC from advertisements)', () => {
  it('resolves the MAC from a later advertisement when the first carries no manufacturer data', async () => {
    const fixture = await loadFixture(FIXTURES.moyu32_my33_noGyro);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, {
      deviceId: 'moyu32_adv',
      maxAutoFlushNotifies: 0,
    });
    const mac = fixture.device.mac!;
    // Wire format: 2-byte company id, then the address LSB-first.
    const wire = [0x00, 0x00, ...mac.split(':').map((h) => parseInt(h, 16)).reverse()];
    const emit = (mf: Map<number, DataView>) => {
      const evt = new Event('advertisementreceived') as BluetoothAdvertisingEvent;
      (evt as unknown as { manufacturerData: unknown }).manufacturerData = mf;
      device.dispatchEvent(evt);
    };
    (device as unknown as { watchAdvertisements: () => Promise<void> }).watchAdvertisements = async () => {
      emit(new Map());
      setTimeout(() => emit(new Map([[0x0504, new DataView(Uint8Array.from(wire).buffer)]])), 5);
    };

    const conn = await moyu32Protocol.connect(device, undefined, attachmentContextFor(serviceUuidsFromFixture(fixture)));
    // SUPERSEDED: attachmentContextFor() builds this literal.
    // {
    //   serviceUuids: serviceUuidsFromFixture(fixture),
    //   advertisementManufacturerData: null,
    //   enableAddressSearch: false,
    //   onStatus: undefined,
    //   signal: undefined,
    // }
    expect(conn.deviceMAC.toUpperCase()).toBe(mac.toUpperCase());

    const { events, unsubscribe } = collectEvents(conn);
    await replayer.drainNotificationsAsync();
    unsubscribe();
    expect(moves(events).slice(0, 10)).toEqual(fixtureExpectedMoves(fixture, 10));
    await conn.disconnect();
  }, 20_000);
});

describe('moyu32Protocol.connect (MAC validation)', () => {
  it('rejects a malformed MAC from the provider before any write reaches the cube', async () => {
    const fixture = await loadFixture(FIXTURES.moyu32_my33_noGyro);
    const { device } = installMockBluetoothFromFixture(fixture, { deviceId: 'moyu32_badmac', maxAutoFlushNotifies: 0 });
    await expect(
      moyu32Protocol.connect(device, async () => 'not-a-mac', attachmentContextFor(serviceUuidsFromFixture(fixture)))
      // SUPERSEDED: attachmentContextFor() builds this literal.
      // {
      //   serviceUuids: serviceUuidsFromFixture(fixture),
      //   advertisementManufacturerData: null,
      //   enableAddressSearch: false,
      //   onStatus: undefined,
      //   signal: undefined,
      // }
    ).rejects.toThrow(/Invalid MAC address/);
  });

  it('rejects with AbortError when the signal is already aborted', async () => {
    const fixture = await loadFixture(FIXTURES.moyu32_my33_noGyro);
    const { device } = installMockBluetoothFromFixture(fixture, { deviceId: 'moyu32_abort', maxAutoFlushNotifies: 0 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      moyu32Protocol.connect(device, undefined, attachmentContextFor(serviceUuidsFromFixture(fixture), { signal: controller.signal }))
    ).rejects.toMatchObject({ name: 'AbortError' });
    // SUPERSEDED: attachmentContextFor() builds this literal.
    // moyu32Protocol.connect(device, undefined, {
    //   serviceUuids: serviceUuidsFromFixture(fixture),
    //   advertisementManufacturerData: null,
    //   enableAddressSearch: false,
    //   onStatus: undefined,
    //   signal: controller.signal,
    // })
  });
});

describe('moyu32Protocol.connect (capture replay)', () => {
  it('matches fixture decoded events (no gyro device)', async () => {
    const fixture = await loadFixture(FIXTURES.moyu32_my33_noGyro);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, {
      deviceId: 'moyu32_no_gyro',
      maxAutoFlushNotifies: 0,
    });

    const conn = await moyu32Protocol.connect(
      device,
      async () => fixture.device.mac ?? null,
      // SUPERSEDED: attachmentContextFor() builds this literal.
      // {
      //   serviceUuids: serviceUuidsFromFixture(fixture),
      //   advertisementManufacturerData: null,
      //   enableAddressSearch: false,
      //   onStatus: undefined,
      //   signal: undefined,
      // }
      attachmentContextFor(serviceUuidsFromFixture(fixture))
    );

    // gyro is detected lazily (first opcode-171 packet). For this fixture, it should never flip.
    expect(conn.capabilities.gyroscope).toBe(false);

    const { events, unsubscribe } = collectEvents(conn);

    await replayer.drainNotificationsAsync();
    unsubscribe();

    const expectedMoves = fixtureExpectedMoves(fixture, 30);
    const expectedLast = fixtureExpectedLastFacelets(fixture);

    expect(moves(events).slice(0, expectedMoves.length)).toEqual(expectedMoves);
    expect(lastFacelets(events)).toBe(expectedLast);
    expect(moveDirectionMismatches(events)).toEqual([]);

    expect(conn.capabilities.gyroscope).toBe(false);
    expect(events.some((e) => e.type === 'GYRO')).toBe(false);

    await conn.disconnect();
  }, 20_000);

  it('matches fixture decoded events (gyro device flips capability on first gyro packet)', async () => {
    const fixture = await loadFixture(FIXTURES.moyu32_my32);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, {
      deviceId: 'moyu32_gyro',
      maxAutoFlushNotifies: 0,
    });

    const conn = await moyu32Protocol.connect(
      device,
      async () => fixture.device.mac ?? null,
      // SUPERSEDED: attachmentContextFor() builds this literal.
      // {
      //   serviceUuids: serviceUuidsFromFixture(fixture),
      //   advertisementManufacturerData: null,
      //   enableAddressSearch: false,
      //   onStatus: undefined,
      //   signal: undefined,
      // }
      attachmentContextFor(serviceUuidsFromFixture(fixture))
    );

    const { events, unsubscribe } = collectEvents(conn);

    await replayer.drainNotificationsAsync();
    unsubscribe();

    const expectedMoves = fixtureExpectedMoves(fixture, 30);
    const expectedLast = fixtureExpectedLastFacelets(fixture);

    expect(moves(events).slice(0, expectedMoves.length)).toEqual(expectedMoves);
    expect(lastFacelets(events)).toBe(expectedLast);
    expect(moveDirectionMismatches(events)).toEqual([]);

    // This fixture contains gyro traffic; capability should flip and at least one GYRO event should exist.
    expect(conn.capabilities.gyroscope).toBe(true);
    expect(events.some((e) => e.type === 'GYRO')).toBe(true);

    await conn.disconnect();
  }, 20_000);
});

