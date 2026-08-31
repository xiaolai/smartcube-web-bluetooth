import { describe, it, expect } from 'vitest';
import { GanGen3ProtocolDriver, type GanCubeEvent } from '../../gan-cube-protocol';

/**
 * GAN gen3 has no capture fixture, so this test pins the driver's decode behaviour with
 * synthetic packets: initial FACELETS, a move, a serial gap that triggers a move-history
 * request (whose request bytes are pinned too), the history response, battery and hardware.
 * The snapshot was generated from the driver as of the commit introducing this test.
 */

function setBitsBE(bytes: Uint8Array, bitOffset: number, bitLength: number, value: number): void {
  for (let i = 0; i < bitLength; i++) {
    const bit = (value >> (bitLength - 1 - i)) & 1;
    const idx = bitOffset + i;
    const byteIndex = Math.floor(idx / 8);
    const mask = 1 << (7 - (idx % 8));
    if (bit) bytes[byteIndex]! |= mask;
    else bytes[byteIndex]! &= ~mask;
  }
}

function gen3Packet(eventType: number, dataLength: number): Uint8Array {
  const e = new Uint8Array(20);
  e[0] = 0x55;
  e[1] = eventType;
  e[2] = dataLength;
  return e;
}

/** Solved-state FACELETS (0x02): serial LE16 at bits 24, cp@40, co@61, ep@77, eo@121. */
function gen3Facelets(serial: number): Uint8Array {
  const e = gen3Packet(0x02, 14);
  e[3] = serial & 0xff;
  e[4] = (serial >> 8) & 0xff;
  for (let i = 0; i < 7; i++) setBitsBE(e, 40 + i * 3, 3, i);
  for (let i = 0; i < 11; i++) setBitsBE(e, 77 + i * 4, 4, i);
  return e;
}

/** MOVE (0x01): cubeTimestamp LE32 at bits 24, serial LE16 at 56, direction@72(2), face code@74(6). */
function gen3Move(serial: number): Uint8Array {
  const e = gen3Packet(0x01, 8);
  const ts = serial * 1000;
  e[3] = ts & 0xff;
  e[4] = (ts >> 8) & 0xff;
  e[5] = (ts >> 16) & 0xff;
  e[6] = (ts >> 24) & 0xff;
  e[7] = serial & 0xff;
  e[8] = (serial >> 8) & 0xff;
  e[9] = 0x02; // direction 0, face code 2 (= U)
  return e;
}

/** MOVE_HISTORY (0x06): startSerial at byte 3, 4-bit entries (3-bit face code + direction) from bit 32. */
function gen3History(startSerial: number, count: number): Uint8Array {
  const e = gen3Packet(0x06, count / 2 + 1);
  e[3] = startSerial;
  for (let i = 0; i < count; i++) {
    setBitsBE(e, 32 + 4 * i, 3, 1); // face code 1 = U in the history table
    setBitsBE(e, 35 + 4 * i, 1, 0);
  }
  return e;
}

function gen3Battery(level: number): Uint8Array {
  const e = gen3Packet(0x10, 2);
  e[3] = level;
  return e;
}

function gen3Hardware(): Uint8Array {
  const e = gen3Packet(0x07, 8);
  const name = 'iC2ab';
  for (let i = 0; i < 5; i++) e[4 + i] = name.charCodeAt(i);
  e[9] = 0x15; // sw 1.5
  e[10] = 0x21; // hw 2.1
  return e;
}

type SnapshotEvent = {
  type: string;
  serial?: number;
  move?: string;
  face?: number;
  direction?: number;
  cubeTimestamp?: number | null;
  hasLocalTimestamp?: boolean;
  facelets?: string;
  batteryLevel?: number;
  hardwareName?: string;
  softwareVersion?: string;
  hardwareVersion?: string;
  gyroSupported?: boolean;
};

function normalise(e: GanCubeEvent): SnapshotEvent {
  switch (e.type) {
    case 'MOVE':
      return {
        type: e.type,
        serial: e.serial,
        move: e.move,
        face: e.face,
        direction: e.direction,
        cubeTimestamp: e.cubeTimestamp,
        hasLocalTimestamp: e.localTimestamp != null,
      };
    case 'FACELETS':
      return { type: e.type, serial: e.serial, facelets: e.facelets };
    case 'BATTERY':
      return { type: e.type, batteryLevel: e.batteryLevel };
    case 'HARDWARE':
      return {
        type: e.type,
        hardwareName: e.hardwareName,
        softwareVersion: e.softwareVersion,
        hardwareVersion: e.hardwareVersion,
        gyroSupported: e.gyroSupported,
      };
    default:
      return { type: e.type };
  }
}

describe('GanGen3ProtocolDriver characterisation', () => {
  it('decodes the synthetic session exactly as pinned', async () => {
    const driver = new GanGen3ProtocolDriver();
    const writes: string[] = [];
    const conn = {
      sendCommandMessage: async (m: Uint8Array) => {
        writes.push(Array.from(m).map((b) => b.toString(16).padStart(2, '0')).join(''));
      },
      disconnect: async () => {},
    };

    const steps: Array<[string, Uint8Array]> = [
      ['facelets serial 0', gen3Facelets(0)],
      ['move serial 1', gen3Move(1)],
      ['move serial 4 (gap -> history request)', gen3Move(4)],
      ['history response from serial 3', gen3History(3, 4)],
      ['battery 85', gen3Battery(85)],
      ['hardware', gen3Hardware()],
    ];

    const log: Record<string, SnapshotEvent[]> = {};
    for (const [label, packet] of steps) {
      const events = await driver.handleStateEvent(conn, packet);
      log[label] = events.map(normalise);
    }

    await expect(JSON.stringify({ log, writes }, null, 2) + '\n').toMatchFileSnapshot(
      './__snapshots__/gan-gen3-driver.characterisation.json'
    );
  });
});
