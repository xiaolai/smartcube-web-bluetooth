import { describe, it, expect } from 'vitest';
import { FIXTURES, loadFixture, type FixtureSession } from '../fixtures';
import { installMockBluetoothFromFixture } from '../bluetooth-mock';
import { attachmentContextFor, serviceUuidsFromFixture } from '../helpers/fixture-replay';
import { collectEvents, fixtureExpectedMoves, moves } from '../helpers/events';
import { giikerProtocol } from '../../smartcube/protocols/giiker';
import { qiyiProtocol } from '../../smartcube/protocols/qiyi';

function ctx(fixture: FixtureSession) {
  return attachmentContextFor(serviceUuidsFromFixture(fixture));
  // SUPERSEDED: attachmentContextFor() builds this literal.
  // {
  //   serviceUuids: serviceUuidsFromFixture(fixture),
  //   advertisementManufacturerData: null,
  //   enableAddressSearch: false,
  //   onStatus: undefined,
  //   signal: undefined,
  // }
}

async function characteristic(device: BluetoothDevice, service: string, chr: string): Promise<BluetoothRemoteGATTCharacteristic> {
  return (await device.gatt!.getPrimaryService(service)).getCharacteristic(chr);
}

function inject(chr: BluetoothRemoteGATTCharacteristic, byteLength: number): () => void {
  return () => {
    (chr as unknown as { value: DataView }).value = new DataView(new ArrayBuffer(byteLength));
    chr.dispatchEvent(new Event('characteristicvaluechanged'));
  };
}

describe('truncated notification frames are dropped', () => {
  it('giiker: a short state frame neither throws nor emits, and later frames still decode', async () => {
    const fixture = await loadFixture(FIXTURES.giiker);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'giiker-short', maxAutoFlushNotifies: 0 });
    const conn = await giikerProtocol.connect(device, undefined, ctx(fixture));
    const chr = await characteristic(device, '0000aadb-0000-1000-8000-00805f9b34fb', '0000aadc-0000-1000-8000-00805f9b34fb');

    const { events, unsubscribe } = collectEvents(conn);
    expect(inject(chr, 5)).not.toThrow();
    expect(events).toHaveLength(0);

    await replayer.drainNotificationsAsync();
    unsubscribe();
    expect(moves(events).slice(0, 5)).toEqual(fixtureExpectedMoves(fixture, 5));
    await conn.disconnect();
  }, 20_000);

  it('qiyi: a frame that is not whole AES blocks neither throws nor emits, and later frames still decode', async () => {
    const fixture = await loadFixture(FIXTURES.qiyi);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'qiyi-short' });
    const conn = await qiyiProtocol.connect(device, async () => fixture.device.mac ?? null, ctx(fixture));
    const chr = await characteristic(device, '0000fff0-0000-1000-8000-00805f9b34fb', '0000fff6-0000-1000-8000-00805f9b34fb');

    const { events, unsubscribe } = collectEvents(conn);
    expect(inject(chr, 7)).not.toThrow();
    expect(events).toHaveLength(0);

    await replayer.drainNotificationsAsync();
    unsubscribe();
    expect(moves(events).slice(0, 5)).toEqual(fixtureExpectedMoves(fixture, 5));
    await conn.disconnect();
  }, 20_000);
});
