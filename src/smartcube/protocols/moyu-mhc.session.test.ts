import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { moyuMhcProtocol } from './moyu-mhc';
import { MOYU_V1_SOLVED_STICKERS, moyuV1EncodeCubeStatePayload } from './moyu-v1';
import { CubieCube, SOLVED_FACELET } from '../cubie-cube';
import type { SmartCubeConnection, SmartCubeEvent } from '../types';
import { MOYU_MHC_SERVICE } from '../gatt-uuids';
import { attachmentContextFor } from '../../test/helpers/fixture-replay';
import { MHC_CMD_BATTERY, MHC_CMD_CUBE_STATE, MHC_CMD_HARDWARE, mhcDevice, stickersFromFacelets, type MhcDevice } from '../../test/helpers/moyu-mhc-device';

/**
 * A full MHC session against a scripted cube that answers the v1 protocol: init sync, turn
 * tracking, gyro, every command, failure modes, polling and teardown. Device face order is
 * (D, L, B, R, F, U); the cube counts face rotation in ninths of a turn and the driver emits a
 * move when a face crosses the half-turn line between 4 and 5.
 */

const QUARTER_TURN = 36; // int8 degrees per notification that the driver rounds to one ninth
const CUBE_TICKS_PER_SECOND = 65536;
const V1_TIMEOUT_MS = 5000;
const BATTERY_POLL_MS = 60_000;

/** URFDLB facelets after applying `moves` (standard notation) to the solved cube. */
function faceletsAfter(...moves: string[]): string {
  let cube = new CubieCube();
  for (const m of moves) {
    const face = 'URFDLB'.indexOf(m.charAt(0));
    const power = { '': 0, '2': 1, "'": 2 }[m.slice(1)]!;
    const next = new CubieCube();
    CubieCube.CubeMult(cube, CubieCube.moveCube[face * 3 + power]!, next);
    cube = next;
  }
  return cube.toFaceCube();
}

async function connect(d: MhcDevice): Promise<SmartCubeConnection> {
  return moyuMhcProtocol.connect(d.device, undefined, attachmentContextFor(new Set([MOYU_MHC_SERVICE.toUpperCase()])));
}

function collect(conn: SmartCubeConnection): { events: SmartCubeEvent[]; completed: () => boolean } {
  const events: SmartCubeEvent[] = [];
  let done = false;
  conn.events$.subscribe({ next: (e) => events.push(e), complete: () => (done = true) });
  return { events, completed: () => done };
}

const ofType = <T extends SmartCubeEvent['type']>(events: SmartCubeEvent[], type: T) =>
  events.filter((e): e is Extract<SmartCubeEvent, { type: T }> => e.type === type);

/** Angles at 4: the next quarter turn forward crosses into a move. */
const ARMED_ANGLES = [4, 4, 4, 4, 4, 4];

describe('MoYu MHC session (scripted v1 cube)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('init: reads the cube state before enabling turns, then the battery, and reports every capability', async () => {
    const d = mhcDevice({ angles: ARMED_ANGLES });
    const conn = await connect(d);

    expect(d.received.map((r) => r.command)).toEqual([MHC_CMD_CUBE_STATE, MHC_CMD_BATTERY]);
    expect(conn.deviceName).toBe('MHC_TEST');
    expect(conn.deviceMAC).toBe('');
    expect(conn.protocol.id).toBe('moyu-mhc');
    expect(conn.capabilities).toEqual({ gyroscope: true, battery: true, facelets: true, hardware: true, reset: true });
    const snap = conn.getSnapshot();
    expect(snap.facelets?.value).toBe(SOLVED_FACELET);
    expect(snap.battery?.value).toBe(66);
    for (const c of [d.chr.read, d.chr.turn, d.chr.gyro]) expect(c!.startNotifications).toHaveBeenCalledTimes(1);
    await conn.disconnect();
  });

  describe('turn tracking', () => {
    it('a face crossing the half-turn line forward is a clockwise move with the cube timestamp and tracked facelets', async () => {
      const d = mhcDevice({ angles: ARMED_ANGLES });
      const conn = await connect(d);
      const { events } = collect(conn);

      d.turn([{ face: 0, degrees: QUARTER_TURN, ts: 3 * CUBE_TICKS_PER_SECOND }]); // device face 0 is D

      const [mv] = ofType(events, 'MOVE');
      expect(mv).toMatchObject({ move: 'D', face: 3, direction: 0, cubeTimestamp: 3000 });
      expect(mv!.localTimestamp).toBe(mv!.timestamp);
      expect(ofType(events, 'FACELETS').map((f) => f.facelets)).toEqual([faceletsAfter('D')]);
      await conn.disconnect();
    });

    it('crossing back is the counter-clockwise move and the state returns to solved', async () => {
      const d = mhcDevice({ angles: ARMED_ANGLES });
      const conn = await connect(d);
      const { events } = collect(conn);
      d.turn([{ face: 0, degrees: QUARTER_TURN }]);
      d.turn([{ face: 0, degrees: -QUARTER_TURN }]);
      expect(ofType(events, 'MOVE').map((m) => [m.move, m.direction])).toEqual([['D', 0], ["D'", 1]]);
      expect(ofType(events, 'FACELETS').at(-1)?.facelets).toBe(SOLVED_FACELET);
      await conn.disconnect();
    });

    it('maps every device face to its axis', async () => {
      const d = mhcDevice({ angles: ARMED_ANGLES });
      const conn = await connect(d);
      const { events } = collect(conn);
      for (let face = 0; face < 6; face++) d.turn([{ face, degrees: QUARTER_TURN }]);
      expect(ofType(events, 'MOVE').map((m) => m.move)).toEqual(['D', 'L', 'B', 'R', 'F', 'U']);
      await conn.disconnect();
    });

    it('rotation that stays on one side of the line, several moves in one frame, unknown faces and truncated frames', async () => {
      const d = mhcDevice({ angles: [0, 0, 0, 4, 4, 0] });
      const conn = await connect(d);
      const { events } = collect(conn);

      d.turn([{ face: 0, degrees: QUARTER_TURN }]); // 0 -> 1: no move yet
      expect(ofType(events, 'MOVE')).toHaveLength(0);

      d.turn([{ face: 3, degrees: QUARTER_TURN }, { face: 4, degrees: QUARTER_TURN }]); // two moves, one frame
      expect(ofType(events, 'MOVE').map((m) => m.move)).toEqual(['R', 'F']);

      d.turn([{ face: 6, degrees: QUARTER_TURN }]); // not a face
      d.turn([{ face: 3, degrees: -QUARTER_TURN }], 5); // declares one move, carries half of it
      expect(ofType(events, 'MOVE')).toHaveLength(2);
      await conn.disconnect();
    });
  });

  it('gyro: normalizes the float quaternion and flips y; short, non-finite and all-zero samples are ignored', async () => {
    const d = mhcDevice();
    const conn = await connect(d);
    const { events } = collect(conn);

    d.gyro({ w: 2, x: 0, y: 2, z: 0 });
    const [g] = ofType(events, 'GYRO');
    expect(g!.quaternion.w).toBeCloseTo(Math.SQRT1_2, 6);
    expect(g!.quaternion.y).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(g!.quaternion.x).toBe(0);
    expect(g!.quaternion.z).toBe(0);

    d.chr.gyro!.notify(new Uint8Array(10));
    d.gyro({ w: Number.NaN, x: 0, y: 0, z: 0 });
    d.gyro({ w: 0, x: 0, y: 0, z: 0 });
    expect(ofType(events, 'GYRO')).toHaveLength(1);
    await conn.disconnect();
  });

  describe('commands', () => {
    it('REQUEST_HARDWARE reports the firmware version the cube returns', async () => {
      const d = mhcDevice();
      const conn = await connect(d);
      const { events } = collect(conn);
      await conn.sendCommand({ type: 'REQUEST_HARDWARE' });
      expect(ofType(events, 'HARDWARE')).toEqual([
        expect.objectContaining({ hardwareName: 'MHC_TEST', softwareVersion: '1.2.34', gyroSupported: true }),
      ]);
      expect(d.received.at(-1)?.command).toBe(MHC_CMD_HARDWARE);
      await conn.disconnect();
    });

    it('REQUEST_BATTERY re-reads the level and reports it even when unchanged', async () => {
      const d = mhcDevice();
      const conn = await connect(d);
      const { events } = collect(conn);
      await conn.sendCommand({ type: 'REQUEST_BATTERY' });
      expect(ofType(events, 'BATTERY').map((b) => b.batteryLevel)).toEqual([66]);
      await conn.disconnect();
    });

    it("REQUEST_FACELETS adopts the cube's own state and realigns the turn counters to its angles", async () => {
      const d = mhcDevice();
      const conn = await connect(d);
      const { events } = collect(conn);

      d.state.stickers = stickersFromFacelets(faceletsAfter('R'));
      d.state.angles = ARMED_ANGLES;
      await conn.sendCommand({ type: 'REQUEST_FACELETS' });
      expect(ofType(events, 'FACELETS').map((f) => f.facelets)).toEqual([faceletsAfter('R')]);

      d.turn([{ face: 3, degrees: QUARTER_TURN }]); // counters now armed: one quarter turn is a move
      expect(ofType(events, 'MOVE').map((m) => m.move)).toEqual(['R']);
      expect(ofType(events, 'FACELETS').at(-1)?.facelets).toBe(faceletsAfter('R', 'R'));
      await conn.disconnect();
    });

    it('REQUEST_FACELETS rejects a state that is not a legal cube and keeps the tracked one', async () => {
      const d = mhcDevice();
      const conn = await connect(d);
      d.state.stickers = MOYU_V1_SOLVED_STICKERS.map(() => new Array<number>(9).fill(0)); // 54 of one colour
      await expect(conn.sendCommand({ type: 'REQUEST_FACELETS' })).rejects.toThrow(/invalid cube state/);
      expect(conn.getSnapshot().facelets?.value).toBe(SOLVED_FACELET);
      await conn.disconnect();
    });

    it('REQUEST_RESET writes the solved state to the cube, reports solved, and disarms the turn counters', async () => {
      const d = mhcDevice({ angles: ARMED_ANGLES });
      const conn = await connect(d);
      const { events } = collect(conn);
      d.turn([{ face: 5, degrees: QUARTER_TURN }]); // U
      await conn.sendCommand({ type: 'REQUEST_RESET' });

      const write = d.received.at(-1)!;
      expect(write.command).toBe(MHC_CMD_CUBE_STATE);
      expect([...write.payload.subarray(0, 30)]).toEqual([...moyuV1EncodeCubeStatePayload(MOYU_V1_SOLVED_STICKERS, [0, 0, 0, 0, 0, 0])]);
      expect(d.state.angles).toEqual([0, 0, 0, 0, 0, 0]);
      expect(ofType(events, 'FACELETS').at(-1)?.facelets).toBe(SOLVED_FACELET);

      d.turn([{ face: 5, degrees: QUARTER_TURN }]); // from 0: no crossing
      expect(ofType(events, 'MOVE')).toHaveLength(1);
      await conn.disconnect();
    });

    it('a cube that stays silent times out the command after five seconds', async () => {
      const d = mhcDevice();
      const conn = await connect(d);
      d.behaviour[MHC_CMD_HARDWARE] = 'silent';
      const p = conn.sendCommand({ type: 'REQUEST_HARDWARE' });
      const expectation = expect(p).rejects.toThrow(/timeout/);
      await vi.advanceTimersByTimeAsync(V1_TIMEOUT_MS + 1);
      await expectation;
      await conn.disconnect();
    });

    it('a cube that answers with a failure rejects the command', async () => {
      const d = mhcDevice();
      const conn = await connect(d);
      d.behaviour[MHC_CMD_HARDWARE] = 'fail';
      await expect(conn.sendCommand({ type: 'REQUEST_HARDWARE' })).rejects.toThrow(/command 2 failed/);
      await conn.disconnect();
    });
  });

  it('init survives a failed state read: facelets stay unknown rather than pretending solved', async () => {
    const d = mhcDevice();
    d.behaviour[MHC_CMD_CUBE_STATE] = 'fail';
    const conn = await connect(d);
    expect(conn.getSnapshot().facelets).toBeNull();
    expect(conn.getSnapshot().battery?.value).toBe(66);
    expect(conn.capabilities.facelets).toBe(true);
    await conn.disconnect();
  });

  it('polls the battery every minute and reports changes', async () => {
    const d = mhcDevice();
    const conn = await connect(d);
    const { events } = collect(conn);
    d.state.battery.percentage = 50;
    await vi.advanceTimersByTimeAsync(BATTERY_POLL_MS + 10);
    expect(ofType(events, 'BATTERY').map((b) => b.batteryLevel)).toEqual([50]);
    await conn.disconnect();
  });

  describe('gating by the characteristics the cube exposes', () => {
    it('v1 without turn notifications still reports facelets, battery, hardware and reset', async () => {
      const d = mhcDevice({ turn: false, gyro: false });
      const conn = await connect(d);
      expect(conn.capabilities).toEqual({ gyroscope: false, battery: true, facelets: true, hardware: true, reset: true });
      await conn.disconnect();
    });

    it('a write-only profile has no v1 client: turns work, commands are no-ops', async () => {
      const d = mhcDevice({ read: false, gyro: false, angles: ARMED_ANGLES });
      const conn = await connect(d);
      expect(conn.capabilities).toEqual({ gyroscope: false, battery: false, facelets: true, hardware: false, reset: false });
      await conn.sendCommand({ type: 'REQUEST_HARDWARE' });
      expect(d.chr.write!.writeValueWithResponse).not.toHaveBeenCalled();
      await conn.disconnect();
    });
  });

  describe('teardown', () => {
    it('a remote drop rejects in-flight requests, emits DISCONNECT once, completes the stream and stops polling', async () => {
      const d = mhcDevice();
      const conn = await connect(d);
      const { events, completed } = collect(conn);
      d.behaviour[MHC_CMD_HARDWARE] = 'silent';
      const pending = conn.sendCommand({ type: 'REQUEST_HARDWARE' });
      const expectation = expect(pending).rejects.toThrow(/disposed/);
      d.dropLink();
      await expectation;
      expect(ofType(events, 'DISCONNECT')).toHaveLength(1);
      expect(completed()).toBe(true);
      const writes = d.chr.write!.writeValueWithResponse.mock.calls.length;
      await vi.advanceTimersByTimeAsync(BATTERY_POLL_MS * 2);
      expect(d.chr.write!.writeValueWithResponse).toHaveBeenCalledTimes(writes);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('disconnect() stops every notifying characteristic and drops GATT', async () => {
      const d = mhcDevice();
      const conn = await connect(d);
      await conn.disconnect();
      for (const c of [d.chr.read, d.chr.turn, d.chr.gyro]) expect(c!.stopNotifications).toHaveBeenCalledTimes(1);
      expect(d.gattDisconnect).toHaveBeenCalledTimes(1);
      expect(conn.getSnapshot().connected).toBe(false);
    });
  });
});
