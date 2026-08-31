import { describe, it, expect } from 'vitest';
import type { FixtureSession } from '../../test/fixtures';
import { installMockBluetoothFromFixture } from '../../test/bluetooth-mock';
import { qiyiProtocol } from '../../smartcube/protocols/qiyi';
import { decryptQiYiBlocks, encryptQiYiMessage, qiyiHelloContent } from '../../smartcube/attachment/qiyi-wire';
import { parseMacBytes } from '../../smartcube/attachment/mac-address';
import { CubieCube, SOLVED_FACELET } from '../../smartcube/cubie-cube';
import type { SmartCubeEvent } from '../../smartcube/types';

const MAC = 'AA:BB:CC:DD:EE:FF';
const SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
const CHR = '0000fff6-0000-1000-8000-00805f9b34fb';

function hex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join('');
}

/** Inverse of the driver's parseFacelet: pack a URFDLB string into 27 nibble bytes. */
function packFacelets(facelets: string): number[] {
  const out = new Array<number>(27).fill(0);
  for (let i = 0; i < 54; i++) {
    const nibble = 'LRDUFB'.indexOf(facelets[i]!);
    out[i >> 1] = out[i >> 1]! | (nibble << ((i % 2) << 2));
  }
  return out;
}

function helloResponseContent(facelets: string, battery: number): number[] {
  return [0x02, 0, 0, 0, 1, ...packFacelets(facelets), 0x00, battery];
}

/** State-change frame with NO decodable moves (invalid primary code, all-FF history). */
function stateChangeContent(facelets: string, battery: number): number[] {
  return [0x03, 0, 0, 0, 2, ...packFacelets(facelets), 0, battery, ...new Array<number>(55).fill(0xff), 0x00];
}

describe('qiyi state-change reconciliation', () => {
  it('adopts the packet facelet snapshot when move tracking has desynchronized', async () => {
    const rTurned = new CubieCube();
    CubieCube.CubeMult(new CubieCube(), CubieCube.moveCube[3]!, rTurned); // R
    const rFacelets = rTurned.toFaceCube();

    const helloFrame = encryptQiYiMessage(qiyiHelloContent(parseMacBytes(MAC)));
    const helloResponse = encryptQiYiMessage(helloResponseContent(SOLVED_FACELET, 90));
    const helloAck = encryptQiYiMessage(Array.from(decryptQiYiBlocks(helloResponse)).slice(2, 7));
    // The cube reports the R-turned state, but its history carries no moves at all —
    // the situation after lost packets or exhausted history.
    const desyncFrame = encryptQiYiMessage(stateChangeContent(rFacelets, 90));

    const fixture: FixtureSession = {
      format: 'smartcube-fixture',
      version: 1,
      capturedAt: new Date().toISOString(),
      device: { name: 'QY-QYSC-S-TEST', id: '', mac: MAC },
      protocol: { id: 'qiyi', name: 'QiYi' },
      services: [],
      traffic: [
        { t: 0, op: 'discover-service', service: SERVICE },
        { t: 1, op: 'discover-char', service: SERVICE, characteristic: CHR },
        { t: 2, op: 'write', service: SERVICE, characteristic: CHR, data: hex(helloFrame) },
        { t: 3, op: 'notify', service: SERVICE, characteristic: CHR, data: hex(helloResponse) },
        { t: 4, op: 'write', service: SERVICE, characteristic: CHR, data: hex(helloAck) },
        { t: 5, op: 'notify', service: SERVICE, characteristic: CHR, data: hex(desyncFrame) },
      ],
      events: [],
    };

    const { device, replayer } = installMockBluetoothFromFixture(fixture, {
      deviceId: 'qiyi-desync',
      maxAutoFlushNotifies: 0,
    });

    const conn = await qiyiProtocol.connect(device, async () => MAC, {
      serviceUuids: new Set([SERVICE]),
      advertisementManufacturerData: null,
      enableAddressSearch: false,
      onStatus: undefined,
      signal: undefined,
    });

    const events: SmartCubeEvent[] = [];
    const sub = conn.events$.subscribe((e) => events.push(e));
    await replayer.drainNotificationsAsync();
    sub.unsubscribe();

    const facelets = events.filter((e) => e.type === 'FACELETS').map((e) => e.facelets);
    // Hello reports solved; the desynchronized state-change (no moves) must still
    // surface the cube's authoritative R-turned state.
    expect(facelets).toEqual([SOLVED_FACELET, rFacelets]);
    expect(events.filter((e) => e.type === 'MOVE')).toHaveLength(0);
    expect(conn.getSnapshot().facelets?.value).toBe(rFacelets);

    await conn.disconnect();
  }, 15_000);
});
