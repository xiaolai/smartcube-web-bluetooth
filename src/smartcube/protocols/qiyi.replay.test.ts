import { describe, it, expect } from 'vitest';
import { FIXTURES, loadFixture } from '../../test/fixtures';
import { installMockBluetoothFromFixture } from '../../test/bluetooth-mock';
import { attachmentContextFor, serviceUuidsFromFixture } from '../../test/helpers/fixture-replay';
import { collectEvents, fixtureExpectedLastFacelets, fixtureExpectedMoves, lastFacelets, moveDirectionMismatches, moves } from '../../test/helpers/events';
import { qiyiProtocol } from './qiyi';

describe('qiyiProtocol.connect (capture replay)', () => {
  it('matches fixture decoded events', async () => {
    const fixture = await loadFixture(FIXTURES.qiyi);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'qiyi-replay' });

    const conn = await qiyiProtocol.connect(
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

    const expectedMoves = fixtureExpectedMoves(fixture, 25);
    const expectedLast = fixtureExpectedLastFacelets(fixture);
    expect(moves(events).slice(0, expectedMoves.length)).toEqual(expectedMoves);
    expect(lastFacelets(events)).toBe(expectedLast);
    expect(moveDirectionMismatches(events)).toEqual([]);

    await conn.disconnect();
  }, 20_000);
});

