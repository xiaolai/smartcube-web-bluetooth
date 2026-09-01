import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GanGen1CubeConnection } from '../../gan-gen1';
import type { GanCubeEvent } from '../../gan-cube-protocol';
import { gen1Device, gen1Facelets, gen1MoveCode, GEN1_SOLVED, type Gen1Device } from '../helpers/gen1-device';

/**
 * GAN gen1 is polled: the driver reads FFF5 every 30 ms and decodes moves, gyro and battery
 * from what it reads. Fake timers drive the poll loop; the device helper's frames are live
 * arrays the scenarios mutate between polls.
 */

const POLL_MS = 30;
const BATTERY_MS = 60_000;

async function connect(d: Gen1Device): Promise<GanGen1CubeConnection> {
  await d.device.gatt!.connect();
  return GanGen1CubeConnection.create(d.device);
}

function collect(conn: GanGen1CubeConnection): { events: GanCubeEvent[]; completed: () => boolean } {
  const events: GanCubeEvent[] = [];
  let done = false;
  conn.events$.subscribe({ next: (e) => events.push(e), complete: () => (done = true) });
  return { events, completed: () => done };
}

const ofType = <T extends GanCubeEvent['type']>(events: GanCubeEvent[], type: T) =>
  events.filter((e): e is Extract<GanCubeEvent, { type: T }> => e.type === type);

/** Let the poll loop run once (one 30 ms timer plus the reads behind it). */
const poll = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(POLL_MS + 1);
};

/** Little-endian 16-bit into a frame. */
function put16(frame: number[], at: number, value: number): void {
  frame[at] = value & 0xff;
  frame[at + 1] = (value >> 8) & 0xff;
}

describe('GanGen1CubeConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The driver's clock is performance.now(); tie it to the faked Date so battery intervals elapse.
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('setup', () => {
    it('reads firmware and hardware, derives the key, and emits the initial facelets and battery during create()', async () => {
      const d = gen1Device();
      const seen: GanCubeEvent[] = [];
      // create() takes an external subject so a caller can observe the init emissions.
      const { Subject } = await import('rxjs');
      const events$ = new Subject<GanCubeEvent>();
      events$.subscribe((e) => seen.push(e));
      await d.device.gatt!.connect();
      const conn = await GanGen1CubeConnection.create(d.device, events$);

      expect(seen.map((e) => e.type)).toEqual(['FACELETS', 'BATTERY']);
      expect(seen[0]).toMatchObject({ facelets: GEN1_SOLVED, serial: 0 });
      expect(seen[1]).toMatchObject({ batteryLevel: 85 });
      expect(d.chr.gyro!.startNotifications).toHaveBeenCalledTimes(1);
      await conn.disconnect();
    });

    it('rejects firmware outside the gen1 range before touching the primary service', async () => {
      const d = gen1Device({ firmware: [0x02, 0x00, 0x08] });
      await expect(connect(d)).rejects.toThrow(/Invalid firmware version/);
      expect(d.chr.facelets.readValue).not.toHaveBeenCalled();
    });

    it('fails create() and stops gyro notifications when the initial facelets are not a legal cube', async () => {
      const d = gen1Device({ facelets: gen1Facelets([0, 0, 0, 0, 0, 0]) });
      await expect(connect(d)).rejects.toThrow(/invalid facelet state/);
      expect(d.chr.gyro!.stopNotifications).toHaveBeenCalledTimes(1);
      // No poll loop was started: nothing reads FFF5 afterwards.
      await vi.advanceTimersByTimeAsync(POLL_MS * 5);
      expect(d.chr.state.readValue).not.toHaveBeenCalled();
    });
  });

  describe('gyro', () => {
    it('decodes FFF4 notifications with the (-raw1, raw2, -raw0) axis mapping and a reconstructed w', async () => {
      const d = gen1Device();
      const conn = await connect(d);
      const { events } = collect(conn);

      const frame = new Array<number>(19).fill(0);
      put16(frame, 0, 0); // raw0
      put16(frame, 2, 8192); // raw1 = 0.5
      put16(frame, 4, 65536 - 4096); // raw2 = -0.25 (sign-extended)
      d.chr.gyro!.notify(d.encrypt(frame));

      const [gyro] = ofType(events, 'GYRO');
      expect(gyro).toBeDefined();
      expect(gyro!.quaternion.x).toBeCloseTo(-0.5, 6);
      expect(gyro!.quaternion.y).toBeCloseTo(-0.25, 6);
      expect(gyro!.quaternion.z).toBeCloseTo(0, 6);
      expect(gyro!.quaternion.w).toBeCloseTo(Math.sqrt(1 - 0.25 - 0.0625), 6);
      await conn.disconnect();
    });

    it('never emits orientation from the polled state frame while FFF4 notifications are available', async () => {
      const d = gen1Device();
      put16(d.state, 2, 8192);
      const conn = await connect(d);
      const { events } = collect(conn);
      await poll();
      await poll();
      expect(ofType(events, 'GYRO')).toHaveLength(0);
      await conn.disconnect();
    });

    it('falls back to the polled state frame for orientation when the profile has no FFF4', async () => {
      const d = gen1Device({ withGyroNotify: false });
      put16(d.state, 2, 8192);
      const conn = await connect(d);
      const { events } = collect(conn);
      await poll();
      const [gyro] = ofType(events, 'GYRO');
      expect(gyro!.quaternion.x).toBeCloseTo(-0.5, 6);
      await conn.disconnect();
    });
  });

  describe('moves', () => {
    it('emits the moves since the last counter with serials, notation, direction and cube timestamps, newest last', async () => {
      const d = gen1Device();
      const conn = await connect(d);
      const { events } = collect(conn);
      await poll(); // seeds the counter without emitting

      d.state[12] = 2;
      d.state[17] = gen1MoveCode(1, 0); // R, the older move
      d.state[18] = gen1MoveCode(0, 2); // U', the newest
      put16(d.timing, 15, 5); // timestamp slot for the older move
      put16(d.timing, 17, 16); // newest
      await poll();

      const mv = ofType(events, 'MOVE');
      expect(mv.map((m) => m.move)).toEqual(['R', "U'"]);
      expect(mv.map((m) => m.serial)).toEqual([1, 2]);
      expect(mv.map((m) => [m.face, m.direction])).toEqual([[1, 0], [0, 1]]);
      expect(mv.map((m) => m.cubeTimestamp)).toEqual([5, 16]);
      expect(mv[0]!.localTimestamp).toBeNull();
      expect(mv[1]!.localTimestamp).toBe(mv[1]!.timestamp);
      await conn.disconnect();
    });

    it('caps a counter jump at the six move slots the frame carries', async () => {
      const d = gen1Device();
      const conn = await connect(d);
      const { events } = collect(conn);
      await poll();
      d.state[12] = 40;
      for (let i = 13; i <= 18; i++) d.state[i] = gen1MoveCode(2, 1); // F2 x6
      await poll();
      const mv = ofType(events, 'MOVE');
      expect(mv).toHaveLength(6);
      expect(mv.map((m) => m.serial)).toEqual([35, 36, 37, 38, 39, 40]);
      expect(mv.every((m) => m.move === 'F2' && m.direction === 2)).toBe(true);
      await conn.disconnect();
    });

    it('treats an out-of-range move code as an unreliable frame: no moves, facelets re-read instead', async () => {
      const d = gen1Device();
      const conn = await connect(d);
      const { events } = collect(conn);
      await poll();
      const faceletReads = d.chr.facelets.readValue.mock.calls.length;
      d.state[12] = 1;
      d.state[18] = 18; // one past the last valid code
      await poll();
      expect(ofType(events, 'MOVE')).toHaveLength(0);
      expect(d.chr.facelets.readValue).toHaveBeenCalledTimes(faceletReads + 1);
      expect(ofType(events, 'FACELETS')).toHaveLength(1);
      await conn.disconnect();
    });

    it('reconciles facelets from the cube after twenty observed moves', async () => {
      const d = gen1Device();
      const conn = await connect(d);
      const { events } = collect(conn);
      await poll();
      const faceletReads = d.chr.facelets.readValue.mock.calls.length;
      for (let i = 13; i <= 18; i++) d.state[i] = gen1MoveCode(0, 0);
      for (let step = 1; step <= 3; step++) {
        d.state[12] = step * 6;
        await poll();
      }
      expect(d.chr.facelets.readValue).toHaveBeenCalledTimes(faceletReads); // 18 moves: not yet
      d.state[12] = 24;
      await poll();
      expect(d.chr.facelets.readValue).toHaveBeenCalledTimes(faceletReads + 1);
      expect(ofType(events, 'FACELETS').at(-1)).toMatchObject({ serial: 24 });
      await conn.disconnect();
    });
  });

  describe('battery', () => {
    it('re-reads the battery every minute and reports only changes, unless a request forces it', async () => {
      const d = gen1Device();
      const conn = await connect(d);
      const { events } = collect(conn);

      await vi.advanceTimersByTimeAsync(BATTERY_MS + POLL_MS * 2);
      expect(ofType(events, 'BATTERY')).toHaveLength(0); // still 85: deduplicated

      d.battery[7] = 80;
      await vi.advanceTimersByTimeAsync(BATTERY_MS + POLL_MS * 2);
      expect(ofType(events, 'BATTERY').map((b) => b.batteryLevel)).toEqual([80]);

      await conn.sendCubeCommand({ type: 'REQUEST_BATTERY' });
      expect(ofType(events, 'BATTERY').map((b) => b.batteryLevel)).toEqual([80, 80]);
      await conn.disconnect();
    }, 20_000);

    it('disarms the forced emission when the battery request itself fails', async () => {
      const d = gen1Device();
      const conn = await connect(d);
      const { events } = collect(conn);
      d.chr.battery.failReads = true;
      await expect(conn.sendCubeCommand({ type: 'REQUEST_BATTERY' })).rejects.toThrow(/read failed/);
      d.chr.battery.failReads = false;
      await vi.advanceTimersByTimeAsync(BATTERY_MS + POLL_MS * 2);
      expect(ofType(events, 'BATTERY')).toHaveLength(0); // unchanged level, no leftover force
      await conn.disconnect();
    }, 20_000);
  });

  describe('poll failures', () => {
    it('backs off after a failed poll and resumes decoding once reads work again', async () => {
      const d = gen1Device();
      const conn = await connect(d);
      const { events } = collect(conn);
      await poll();

      d.chr.state.failReads = true;
      const readsBefore = d.chr.state.readValue.mock.calls.length;
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      // Not polled every 30 ms any more: at most one attempt inside a backoff window.
      expect(d.chr.state.readValue.mock.calls.length - readsBefore).toBeLessThanOrEqual(1);

      d.chr.state.failReads = false;
      d.state[12] = 1;
      d.state[18] = gen1MoveCode(3, 0); // D
      await vi.advanceTimersByTimeAsync(2500);
      expect(ofType(events, 'MOVE').map((m) => m.move)).toEqual(['D']);
      expect(events.some((e) => e.type === 'DISCONNECT')).toBe(false);
      await conn.disconnect();
    });

    it('gives up and disconnects after fifty consecutive failures instead of polling a dead link forever', async () => {
      const d = gen1Device();
      const conn = await connect(d);
      const { events, completed } = collect(conn);
      d.chr.state.failReads = true;
      await vi.advanceTimersByTimeAsync(50 * 2000 + 5000);
      expect(events.at(-1)?.type).toBe('DISCONNECT');
      expect(completed()).toBe(true);
      const reads = d.chr.state.readValue.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(d.chr.state.readValue).toHaveBeenCalledTimes(reads); // polling stopped
    }, 20_000);
  });

  describe('teardown', () => {
    it('disconnect() emits DISCONNECT once, completes the stream, stops gyro notifications and drops GATT', async () => {
      const d = gen1Device();
      const conn = await connect(d);
      const { events, completed } = collect(conn);
      await conn.disconnect();
      await conn.disconnect();
      expect(ofType(events, 'DISCONNECT')).toHaveLength(1);
      expect(completed()).toBe(true);
      expect(d.chr.gyro!.stopNotifications).toHaveBeenCalledTimes(1);
      expect(d.gattDisconnect).toHaveBeenCalledTimes(1);
      await expect(conn.sendCubeCommand({ type: 'REQUEST_FACELETS' })).rejects.toThrow(/closed/);
    });

    it('a remote drop tears down the same way and stops the poll loop', async () => {
      const d = gen1Device();
      const conn = await connect(d);
      const { events, completed } = collect(conn);
      await poll();
      const reads = d.chr.state.readValue.mock.calls.length;
      d.dropLink();
      await vi.advanceTimersByTimeAsync(POLL_MS * 5);
      expect(events.at(-1)?.type).toBe('DISCONNECT');
      expect(completed()).toBe(true);
      expect(d.chr.state.readValue.mock.calls.length).toBeLessThanOrEqual(reads + 1);
    });

    it('rejects commands gen1 cannot serve instead of silently succeeding', async () => {
      const d = gen1Device();
      const conn = await connect(d);
      await expect(conn.sendCubeCommand({ type: 'REQUEST_RESET' })).rejects.toThrow(/does not support REQUEST_RESET/);
      await conn.disconnect();
    });
  });
});
