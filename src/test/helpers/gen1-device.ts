import aesjs from 'aes-js';
import { vi } from 'vitest';
import { deriveGen1Key } from '../../gan-gen1';

/**
 * Synthetic GAN gen1 (356i v1) device: a `fff0` primary service whose characteristics are
 * polled reads, plus Device Information for key derivation. Every frame is a live array the
 * test mutates between polls, so a scenario can advance the move counter, corrupt a code,
 * change the battery, or make a read fail.
 */

export const GEN1_SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
/** Passes the gen1 firmware sanity check and selects key table 0. */
export const GEN1_FW = [0x01, 0x00, 0x08];
export const GEN1_HW = [1, 2, 3, 4, 5, 6];

/** Inverse of the gen1 two-block overlapped ECB decrypt. */
export function gen1Encrypt(key: Uint8Array, plain: number[]): number[] {
  const aes = new aesjs.AES([...key]) as unknown as { encrypt(block: number[]): number[] };
  const out = plain.slice();
  const head = aes.encrypt(out.slice(0, 16));
  for (let i = 0; i < 16; i++) out[i] = head[i]!;
  if (out.length > 16) {
    const off = out.length - 16;
    const tail = aes.encrypt(out.slice(off));
    for (let i = 0; i < 16; i++) out[off + i] = tail[i]!;
  }
  return out;
}

/** 18-byte facelets in the gen1 XOR-1 byte order; `faces` is six sticker codes 0-5 (URFDLB), one per face. */
export function gen1Facelets(faces: number[] = [0, 1, 2, 3, 4, 5]): number[] {
  const t = new Array<number>(18).fill(0);
  for (let f = 0; f < 6; f++) {
    const i = 3 * f;
    const n = faces[f]! * 0x249249; // eight identical 3-bit stickers
    t[1 ^ i] = (n >> 16) & 0xff;
    t[(i + 1) ^ 1] = (n >> 8) & 0xff;
    t[(i + 2) ^ 1] = n & 0xff;
  }
  return t;
}

/** Gen1 move code: face index (URFDLB) * 3 + power (0 = CW, 1 = double, 2 = CCW). */
export function gen1MoveCode(face: number, power: number): number {
  return face * 3 + power;
}

export class Gen1MockCharacteristic extends EventTarget {
  readonly uuid: string;
  value: DataView | null = null;
  /** Set to make the next reads reject (poll-failure scenarios). */
  failReads = false;
  readonly startNotifications = vi.fn(async (): Promise<Gen1MockCharacteristic> => this);
  readonly stopNotifications = vi.fn(async (): Promise<Gen1MockCharacteristic> => this);
  readonly readValue = vi.fn(async (): Promise<DataView> => {
    if (this.failReads) throw new Error(`read failed: ${this.uuid}`);
    return new DataView(Uint8Array.from(this.payload()).buffer);
  });

  constructor(uuid: string, private readonly payload: () => number[]) {
    super();
    this.uuid = uuid;
  }

  /** Deliver an (already encrypted) notification. */
  notify(bytes: number[]): void {
    this.value = new DataView(Uint8Array.from(bytes).buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

export type Gen1Device = {
  device: BluetoothDevice;
  /** Encrypt a plaintext frame with the device's derived key. */
  encrypt: (plain: number[]) => number[];
  /** FFF5: gyro raw in [0..5], move counter at [12], move codes at [13..18] (newest last). */
  state: number[];
  /** FFF6: nine little-endian 16-bit cube timestamps, newest at [17..18]. */
  timing: number[];
  /** FFF2 facelets. */
  facelets: number[];
  /** FFF7: battery percentage at [7]. */
  battery: number[];
  chr: {
    state: Gen1MockCharacteristic;
    moves: Gen1MockCharacteristic;
    facelets: Gen1MockCharacteristic;
    battery: Gen1MockCharacteristic;
    gyro: Gen1MockCharacteristic | null;
  };
  gattDisconnect: ReturnType<typeof vi.fn>;
  /** Simulate the peripheral dropping the link. */
  dropLink: () => void;
};

export function gen1Device(opts: { withGyroNotify?: boolean; firmware?: number[]; facelets?: number[] } = {}): Gen1Device {
  const fwBytes = opts.firmware ?? GEN1_FW;
  const fwVersion = (fwBytes[0]! << 16) | (fwBytes[1]! << 8) | fwBytes[2]!;
  const key = deriveGen1Key(fwVersion, new DataView(Uint8Array.from(GEN1_HW).buffer)) ?? new Uint8Array(16);
  const encrypt = (plain: number[]): number[] => gen1Encrypt(key, plain);

  const state = new Array<number>(19).fill(0); // zero quaternion -> w = 1; move counter 0
  const timing = new Array<number>(19).fill(0);
  const facelets = opts.facelets ?? gen1Facelets();
  const battery = new Array<number>(16).fill(0); // gen1 frames are at least one AES block
  battery[7] = 85;

  const chr = {
    state: new Gen1MockCharacteristic('0000fff5-0000-1000-8000-00805f9b34fb', () => encrypt(state)),
    moves: new Gen1MockCharacteristic('0000fff6-0000-1000-8000-00805f9b34fb', () => encrypt(timing)),
    facelets: new Gen1MockCharacteristic('0000fff2-0000-1000-8000-00805f9b34fb', () => encrypt(facelets)),
    battery: new Gen1MockCharacteristic('0000fff7-0000-1000-8000-00805f9b34fb', () => encrypt(battery)),
    gyro: opts.withGyroNotify === false ? null : new Gen1MockCharacteristic('0000fff4-0000-1000-8000-00805f9b34fb', () => encrypt(state)),
  };
  const fw = new Gen1MockCharacteristic('00002a28-0000-1000-8000-00805f9b34fb', () => fwBytes);
  const hw = new Gen1MockCharacteristic('00002a23-0000-1000-8000-00805f9b34fb', () => GEN1_HW);

  const byPrefix = (uuid: string, table: Record<string, Gen1MockCharacteristic | null>): Gen1MockCharacteristic => {
    const hit = Object.entries(table).find(([prefix]) => uuid.toLowerCase().startsWith(prefix));
    if (!hit || !hit[1]) throw new Error(`Characteristic not found: ${uuid}`);
    return hit[1];
  };
  const deviceInfo = { getCharacteristic: async (uuid: string) => byPrefix(uuid, { '00002a28': fw, '00002a23': hw }) };
  const primary = {
    getCharacteristic: async (uuid: string) =>
      byPrefix(uuid, { '0000fff5': chr.state, '0000fff6': chr.moves, '0000fff2': chr.facelets, '0000fff7': chr.battery, '0000fff4': chr.gyro }),
  };
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
    getPrimaryServices: async () => [{ uuid: '0000fff0-0000-1000-8000-00805f9b34fb' }, { uuid: '0000180a-0000-1000-8000-00805f9b34fb' }],
    getPrimaryService: async (uuid: string) => (uuid.toLowerCase().startsWith('0000180a') ? deviceInfo : primary),
  };
  const device = new (class extends EventTarget {
    readonly name = 'GAN-TEST';
    readonly id = 'gan1-test';
    gatt = gatt;
  })() as unknown as BluetoothDevice;

  return {
    device,
    encrypt,
    state,
    timing,
    facelets,
    battery,
    chr,
    gattDisconnect,
    dropLink: () => {
      gatt.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };
}
