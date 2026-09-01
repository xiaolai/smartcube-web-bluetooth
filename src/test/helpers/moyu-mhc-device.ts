import { vi } from 'vitest';
import {
  MOYU_V1_SOLVED_STICKERS,
  moyuStickersToFaceletString,
  moyuV1EncodeCubeStatePayload,
  moyuV1ParseCubeStatePayload,
} from '../../smartcube/protocols/moyu-v1';
import {
  MOYU_MHC_GYRO_CHARACTERISTIC,
  MOYU_MHC_READ_CHARACTERISTIC,
  MOYU_MHC_SERVICE,
  MOYU_MHC_TURN_CHARACTERISTIC,
  MOYU_MHC_WRITE_CHARACTERISTIC,
} from '../../smartcube/gatt-uuids';

/**
 * A scripted MoYu MHC cube. It speaks the v1 request/response protocol the driver writes on
 * 0x1001 — reassembling the driver's frames, answering on 0x1002 in cube-sized parts — and
 * lets a test emit turn (0x1003) and gyro (0x1004) notifications. No capture of a real MHC
 * exists (upstream never recorded one), so this is the closest thing to a session.
 */

const PART_PAYLOAD_SIZE = 18;
export const MHC_CMD_HARDWARE = 2;
export const MHC_CMD_BATTERY = 3;
export const MHC_CMD_CUBE_STATE = 10;

export type MhcCommandBehaviour = 'ok' | 'fail' | 'silent';

export class MhcCharacteristic extends EventTarget {
  value: DataView | null = null;
  readonly properties = { write: true, writeWithoutResponse: false };
  readonly service: { device: object };
  readonly startNotifications = vi.fn(async (): Promise<MhcCharacteristic> => this);
  readonly stopNotifications = vi.fn(async (): Promise<MhcCharacteristic> => this);
  readonly writeValueWithResponse = vi.fn(async (value: BufferSource): Promise<void> => {
    this.onWrite?.(toBytes(value));
  });
  onWrite?: (bytes: Uint8Array) => void;

  constructor(readonly uuid: string, device: object) {
    super();
    this.service = { device };
  }

  notify(bytes: ArrayLike<number>): void {
    this.value = new DataView(Uint8Array.from(bytes).buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function toBytes(src: BufferSource): Uint8Array {
  return src instanceof ArrayBuffer ? new Uint8Array(src.slice(0)) : new Uint8Array(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
}

/** Inverse of moyuStickersToFaceletString, derived by probing it: no second copy of the cell map. */
const cellToStd: number[][] = (() => {
  const map: number[][] = [];
  for (let face = 0; face < 6; face++) {
    map.push([]);
    for (let cell = 0; cell < 9; cell++) {
      const probe = MOYU_V1_SOLVED_STICKERS.map(() => new Array<number>(9).fill(0));
      probe[face]![cell] = 1; // sticker id 1 renders as 'L'
      map[face]!.push(moyuStickersToFaceletString(probe).indexOf('L'));
    }
  }
  return map;
})();

/** Sticker ids (MoYu face order, 0-5 = D L B R F U) for a URFDLB facelet string. */
export function stickersFromFacelets(facelets: string): number[][] {
  return cellToStd.map((row) => row.map((std) => 'DLBRFU'.indexOf(facelets.charAt(std))));
}

export type MhcDevice = {
  device: BluetoothDevice;
  chr: { write: MhcCharacteristic | null; read: MhcCharacteristic | null; turn: MhcCharacteristic | null; gyro: MhcCharacteristic | null };
  /** Live cube state the v1 responses are built from; setCubeState writes into it. */
  state: {
    stickers: number[][];
    angles: number[];
    battery: { charging: boolean; full: boolean; percentage: number; voltage: number };
    hardware: { bootCount: number; major: number; minor: number; patch: number };
  };
  /** Every complete v1 request the cube reassembled, in arrival order. */
  received: { command: number; id: number; payload: Uint8Array }[];
  /** Per-command answer policy; default 'ok'. */
  behaviour: Partial<Record<number, MhcCommandBehaviour>>;
  /** Turn notification: `degrees` is the signed per-move rotation (int8), `ts` the cube clock in 1/65536 s. */
  turn: (moves: { face: number; degrees: number; ts?: number }[], truncateTo?: number) => void;
  /** Gyro notification: the cube's float32 quaternion. */
  gyro: (q: { w: number; x: number; y: number; z: number }) => void;
  gattDisconnect: ReturnType<typeof vi.fn>;
  dropLink: () => void;
};

export function mhcDevice(
  opts: { name?: string; write?: boolean; read?: boolean; turn?: boolean; gyro?: boolean; stickers?: number[][]; angles?: number[] } = {}
): MhcDevice {
  const deviceRef = {} as object;
  const present = (flag: boolean | undefined, uuid: string): MhcCharacteristic | null => (flag === false ? null : new MhcCharacteristic(uuid, deviceRef));
  const chr = {
    write: present(opts.write, MOYU_MHC_WRITE_CHARACTERISTIC),
    read: present(opts.read, MOYU_MHC_READ_CHARACTERISTIC),
    turn: present(opts.turn, MOYU_MHC_TURN_CHARACTERISTIC),
    gyro: present(opts.gyro, MOYU_MHC_GYRO_CHARACTERISTIC),
  };
  const state: MhcDevice['state'] = {
    stickers: opts.stickers ?? MOYU_V1_SOLVED_STICKERS.map((r) => [...r]),
    angles: opts.angles ?? [0, 0, 0, 0, 0, 0],
    battery: { charging: false, full: false, percentage: 66, voltage: 3.7 },
    hardware: { bootCount: 12, major: 1, minor: 2, patch: 34 },
  };
  const received: MhcDevice['received'] = [];
  const behaviour: MhcDevice['behaviour'] = {};

  const respond = (command: number, id: number, success: boolean, payload: number[]): void => {
    const body = [command | ((success ? 1 : 0) << 4) | (id << 5), ...payload];
    const total = Math.max(1, Math.ceil(body.length / PART_PAYLOAD_SIZE));
    for (let index = 0; index < total; index++) {
      const chunk = body.slice(index * PART_PAYLOAD_SIZE, (index + 1) * PART_PAYLOAD_SIZE);
      // Exact-length frames: the driver treats everything after the header as payload.
      chr.read?.notify([0, index | (total << 4), ...chunk]);
    }
  };

  const answer = (command: number, id: number, hasPayload: boolean, payload: Uint8Array): void => {
    const policy = behaviour[command] ?? 'ok';
    if (policy === 'silent') return;
    if (policy === 'fail') {
      respond(command, id, false, []);
      return;
    }
    switch (command) {
      case MHC_CMD_HARDWARE: {
        const p = new Uint8Array(24);
        const v = new DataView(p.buffer);
        v.setUint32(16, state.hardware.bootCount, true);
        v.setUint8(20, state.hardware.major);
        v.setUint8(21, state.hardware.minor);
        v.setUint16(22, state.hardware.patch, true);
        respond(command, id, true, [...p]);
        return;
      }
      case MHC_CMD_BATTERY: {
        const p = new Uint8Array(8);
        const v = new DataView(p.buffer);
        v.setUint8(0, state.battery.charging ? 1 : 0);
        v.setUint8(1, state.battery.full ? 1 : 0);
        v.setUint16(2, state.battery.percentage, true);
        v.setInt32(4, Math.round(state.battery.voltage * 1000), true);
        respond(command, id, true, [...p]);
        return;
      }
      case MHC_CMD_CUBE_STATE: {
        if (hasPayload) {
          const parsed = moyuV1ParseCubeStatePayload(new DataView(payload.buffer, payload.byteOffset, 30));
          state.stickers = parsed.stickers;
          state.angles = parsed.angles;
          respond(command, id, true, []);
          return;
        }
        respond(command, id, true, [...moyuV1EncodeCubeStatePayload(state.stickers, state.angles)]);
        return;
      }
      default:
        respond(command, id, false, []);
    }
  };

  // Reassemble the driver's 20-byte frames: byte 1 is index | total << 4, payload from byte 2.
  let parts: { index: number; payload: Uint8Array }[] = [];
  if (chr.write) {
    chr.write.onWrite = (frame) => {
      const index = frame[1]! & 15;
      const total = frame[1]! >> 4;
      parts.push({ index, payload: frame.subarray(2) });
      if (index !== total - 1) return;
      const body = new Uint8Array(parts.reduce((n, p) => n + p.payload.length, 0));
      let o = 0;
      for (const p of parts.sort((a, b) => a.index - b.index)) {
        body.set(p.payload, o);
        o += p.payload.length;
      }
      parts = [];
      const header = body[0]!;
      const command = header & 15;
      const hasPayload = ((header >> 4) & 1) === 1;
      const id = (header >> 5) & 7;
      const payload = body.subarray(1);
      received.push({ command, id, payload });
      queueMicrotask(() => answer(command, id, hasPayload, payload));
    };
  }

  const gattDisconnect = vi.fn(() => {
    gatt.connected = false;
  });
  const gatt = {
    connected: false,
    connect: async () => {
      gatt.connected = true;
      return gatt;
    },
    disconnect: gattDisconnect,
    getPrimaryServices: async () => [{ uuid: MOYU_MHC_SERVICE }],
    getPrimaryService: async (uuid: string) => {
      if (uuid.toLowerCase() !== MOYU_MHC_SERVICE) throw new Error(`Service not found: ${uuid}`);
      return { getCharacteristics: async () => Object.values(chr).filter((c): c is MhcCharacteristic => c !== null) };
    },
  };
  const device = new (class extends EventTarget {
    readonly name = opts.name ?? 'MHC_TEST';
    readonly id = 'mhc-test';
    gatt = gatt;
  })();
  Object.assign(deviceRef, { id: device.id });

  return {
    device: device as unknown as BluetoothDevice,
    chr,
    state,
    received,
    behaviour,
    turn: (moves, truncateTo) => {
      const frame = new Array<number>(1 + moves.length * 6).fill(0);
      frame[0] = moves.length;
      moves.forEach((m, i) => {
        const o = 1 + i * 6;
        const ts = m.ts ?? 0;
        frame[o + 0] = (ts >>> 16) & 255;
        frame[o + 1] = (ts >>> 24) & 255;
        frame[o + 2] = ts & 255;
        frame[o + 3] = (ts >>> 8) & 255;
        frame[o + 4] = m.face;
        frame[o + 5] = m.degrees & 255;
      });
      chr.turn?.notify(truncateTo === undefined ? frame : frame.slice(0, truncateTo));
    },
    gyro: (q) => {
      const p = new Uint8Array(20);
      const v = new DataView(p.buffer);
      v.setFloat32(4, q.w, true);
      v.setFloat32(8, q.x, true);
      v.setFloat32(12, q.y, true);
      v.setFloat32(16, q.z, true);
      chr.gyro?.notify(p);
    },
    gattDisconnect,
    dropLink: () => {
      gatt.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };
}
