import { describe, it, expect } from 'vitest';
import aesjs from 'aes-js';
import { deriveGen1Key } from '../../gan-gen1';
import { ganProtocol } from '../../smartcube/protocols/gan';
import type { SmartCubeSnapshot } from '../../smartcube/types';

/**
 * Synthetic GAN gen1 (356i v1) GATT: firmware/hardware reads drive key derivation, and the
 * initial facelets/battery are read (and emitted) inside create(), before the SmartCube
 * wrapper can subscribe. This is the acceptance test for capturing those init emissions in
 * the state snapshot.
 */

const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
const FW = [0x01, 0x00, 0x08]; // passes the gen1 firmware sanity check, key table 0
const HW = [1, 2, 3, 4, 5, 6];

/** Inverse of the gen1 two-block overlapped ECB decrypt. */
function gen1Encrypt(key: Uint8Array, plain: number[]): number[] {
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

/** 18-byte solved facelets in the gen1 XOR-1 byte order. */
function gen1SolvedFacelets(): number[] {
  const t = new Array<number>(18).fill(0);
  for (let f = 0; f < 6; f++) {
    const i = 3 * f;
    const n = f * 0x249249; // eight identical 3-bit stickers
    t[1 ^ i] = (n >> 16) & 0xff;
    t[(i + 1) ^ 1] = (n >> 8) & 0xff;
    t[(i + 2) ^ 1] = n & 0xff;
  }
  return t;
}

class MockChr extends EventTarget {
  constructor(private readonly payload: () => number[]) {
    super();
  }
  startNotifications = async (): Promise<MockChr> => this;
  stopNotifications = async (): Promise<MockChr> => this;
  readValue = async (): Promise<DataView> => new DataView(Uint8Array.from(this.payload()).buffer);
}

function installGen1Device(): BluetoothDevice {
  const fwVersion = (FW[0]! << 16) | (FW[1]! << 8) | FW[2]!;
  const key = deriveGen1Key(fwVersion, new DataView(Uint8Array.from(HW).buffer))!;
  const enc = (plain: number[]): number[] => gen1Encrypt(key, plain);

  const state = new Array<number>(19).fill(0); // zero quaternion -> w=1; moveCnt 0
  const battery = new Array<number>(16).fill(0); // gen1 frames are at least one AES block
  battery[7] = 85;

  const deviceInfo = {
    getCharacteristic: async (uuid: string) => {
      if (uuid.startsWith('00002a28')) return new MockChr(() => FW);
      if (uuid.startsWith('00002a23')) return new MockChr(() => HW);
      throw new Error(`unexpected characteristic ${uuid}`);
    },
  };
  const primary = {
    getCharacteristic: async (uuid: string) => {
      if (uuid.startsWith('0000fff5')) return new MockChr(() => enc(state));
      if (uuid.startsWith('0000fff6')) return new MockChr(() => enc(new Array<number>(19).fill(0)));
      if (uuid.startsWith('0000fff2')) return new MockChr(() => enc(gen1SolvedFacelets()));
      if (uuid.startsWith('0000fff7')) return new MockChr(() => enc(battery));
      if (uuid.startsWith('0000fff4')) return new MockChr(() => enc(state));
      throw new Error(`unexpected characteristic ${uuid}`);
    },
  };
  const gatt = {
    connected: true,
    connect: async () => gatt,
    disconnect: () => {},
    getPrimaryServices: async () => [{ uuid: '0000fff0-0000-1000-8000-00805f9b34fb' }, { uuid: '0000180a-0000-1000-8000-00805f9b34fb' }],
    getPrimaryService: async (uuid: string) => (uuid.startsWith('0000180a') ? deviceInfo : primary),
  };
  return new (class extends EventTarget {
    readonly name = 'GAN-TEST';
    readonly id = 'gan1-test';
    gatt = gatt;
  })() as unknown as BluetoothDevice;
}

describe('GAN gen1 through connect (synthetic GATT)', () => {
  it('captures the initial facelets and battery emitted during create() in the state snapshot', async () => {
    const device = installGen1Device();
    const conn = await ganProtocol.connect(device, undefined, {
      serviceUuids: new Set(),
      advertisementManufacturerData: null,
      enableAddressSearch: false,
      onStatus: undefined,
      signal: undefined,
    });

    expect(conn.protocol.id).toBe('gan-gen1');
    const snap = conn.getSnapshot();
    expect(snap.facelets?.value).toBe(SOLVED);
    expect(snap.battery?.value).toBe(85);

    const late: SmartCubeSnapshot[] = [];
    conn.state$.subscribe((s) => late.push(s));
    expect(late[0]!.facelets?.value).toBe(SOLVED);

    await conn.disconnect();
    expect(conn.getSnapshot().connected).toBe(false);
  }, 10_000);
});
