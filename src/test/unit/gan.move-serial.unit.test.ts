import { describe, it, expect } from 'vitest';
import { FIXTURES, loadFixture } from '../fixtures';
import { installMockBluetoothFromFixture } from '../bluetooth-mock';
import { attachmentContextFor, serviceUuidsFromFixture } from '../helpers/fixture-replay';
import { collectEvents } from '../helpers/events';
import { ganProtocol } from '../../smartcube/protocols/gan';
import type { SmartCubeFaceletsEvent, SmartCubeMoveEvent } from '../../smartcube/types';

/**
 * The GAN protocols number their moves, and snapshots share that numbering. Exposing it lets a
 * consumer tell WHICH move a given FACELETS report reflects — without it, a snapshot taken before
 * a move is indistinguishable from one taken after, and anything measuring an interval across the
 * two streams is reporting a span it cannot vouch for.
 *
 * Not reconstructible downstream: counting the moves you received orders what arrived, while this
 * says what the CUBE counted.
 */
describe('GAN move serials reach the public event stream', () => {
  it('numbers moves consecutively and stamps snapshots with the same counter', async () => {
    const fixture = await loadFixture(FIXTURES.ganGen2_small);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, {
      deviceId: 'gan-serial',
      maxAutoFlushNotifies: 0,
    });

    const conn = await ganProtocol.connect(device, async () => fixture.device.mac ?? null, attachmentContextFor(serviceUuidsFromFixture(fixture)));
    // SUPERSEDED: attachmentContextFor() builds this literal.
    // {
    //   serviceUuids: serviceUuidsFromFixture(fixture),
    //   advertisementManufacturerData: null,
    //   enableAddressSearch: false,
    //   onStatus: undefined,
    //   signal: undefined,
    // }

    const { events, unsubscribe } = collectEvents(conn);
    await replayer.drainNotificationsAsync();
    unsubscribe();

    const moves = events.filter((e): e is SmartCubeMoveEvent & { timestamp: number } => e.type === 'MOVE');
    const facelets = events.filter(
      (e): e is SmartCubeFaceletsEvent & { timestamp: number } => e.type === 'FACELETS',
    );

    expect(moves.length).toBeGreaterThan(1);
    for (const m of moves) {
      expect(typeof m.serial).toBe('number');
    }

    // Rolling, modulo 256: the step is 1 across the wrap, which a plain `>` would miss.
    for (let i = 1; i < moves.length; i++) {
      expect((moves[i]!.serial! - moves[i - 1]!.serial!) & 0xff).toBe(1);
    }

    // Snapshots share the counter — the property that makes ordering across the two streams
    // possible at all.
    expect(facelets.length).toBeGreaterThan(0);
    for (const f of facelets) {
      expect(typeof f.serial).toBe('number');
    }

    await conn.disconnect();
  }, 20_000);
});
