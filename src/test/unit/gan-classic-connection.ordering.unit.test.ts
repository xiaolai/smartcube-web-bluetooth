import { describe, it, expect } from 'vitest';
import { GanCubeClassicConnection, GanGen4ProtocolDriver, type GanCubeEvent } from '../../gan-cube-protocol';
import type { GanCubeEncrypter } from '../../gan-cube-encrypter';

const identity: GanCubeEncrypter = { encrypt: (d) => d, decrypt: (d) => d };

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

/** Solved-state gen4 FACELETS packet (0xED) with the given serial. */
function gen4Facelets(serial: number): Uint8Array {
  const e = new Uint8Array(20);
  e[0] = 0xed;
  e[2] = serial & 0xff;
  e[3] = (serial >> 8) & 0xff;
  for (let i = 0; i < 7; i++) setBitsBE(e, 32 + i * 3, 3, i);
  for (let i = 0; i < 11; i++) setBitsBE(e, 69 + i * 4, 4, i);
  return e;
}

/** Gen4 MOVE packet (0x01); one 72-bit chunk per serial, every move a clockwise U. */
function gen4Moves(serials: number[]): Uint8Array {
  const e = new Uint8Array(20);
  serials.forEach((serial, k) => {
    const b = 9 * k; // 72-bit chunks are byte aligned
    e[b] = 0x01;
    e[b + 2] = (serial * 100) & 0xff; // cubeTimestamp (LE), arbitrary but distinct
    e[b + 6] = serial & 0xff;
    e[b + 7] = (serial >> 8) & 0xff;
    e[b + 8] = 0x02; // direction 0 in the top 2 bits, face code 2 (= U) in the bottom 6
  });
  return e;
}

/** Gen4 MOVE_HISTORY response (0xD1): U moves for serials startSerial, startSerial-1, … */
function gen4History(startSerial: number, count: number): Uint8Array {
  const e = new Uint8Array(20);
  e[0] = 0xd1;
  e[1] = count / 2 + 1; // driver derives count = (dataLength - 1) * 2
  e[2] = startSerial;
  for (let i = 0; i < count; i++) {
    setBitsBE(e, 24 + 4 * i, 3, 1); // face code 1 = U in the history table
    setBitsBE(e, 27 + 4 * i, 1, 0); // clockwise
  }
  return e;
}

class MockCharacteristic extends EventTarget {
  value: DataView | null = null;
  readonly service = { device: new EventTarget() };
  readonly properties = {
    broadcast: false,
    read: false,
    writeWithoutResponse: false,
    write: true,
    notify: true,
    indicate: false,
    authenticatedSignedWrites: false,
    reliableWrite: false,
    writableAuxiliaries: false,
  };
  onWrite: () => Promise<void> = async () => {};
  writeValueWithResponse = (_v: BufferSource): Promise<void> => this.onWrite();
  writeValueWithoutResponse = (_v: BufferSource): Promise<void> => this.onWrite();
  startNotifications = async (): Promise<MockCharacteristic> => this;
  stopNotifications = async (): Promise<MockCharacteristic> => this;
  notify(bytes: Uint8Array): void {
    this.value = new DataView(bytes.slice().buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('GanCubeClassicConnection notification ordering (gen4)', () => {
  it('emits recovered moves in serial order while a move-history request is in flight', async () => {
    const command = new MockCharacteristic();
    const state = new MockCharacteristic();
    let releaseWrite!: () => void;
    command.onWrite = () =>
      new Promise<void>((r) => {
        releaseWrite = r;
      });

    const device = new EventTarget();
    const conn = await GanCubeClassicConnection.create(
      device as unknown as BluetoothDevice,
      command as unknown as BluetoothRemoteGATTCharacteristic,
      state as unknown as BluetoothRemoteGATTCharacteristic,
      identity,
      new GanGen4ProtocolDriver()
    );

    const serials: number[] = [];
    conn.events$.subscribe((e: GanCubeEvent) => {
      if (e.type === 'MOVE') serials.push(e.serial);
    });

    state.notify(gen4Facelets(0));
    await tick();
    // One notification with two move chunks: serial 1 evicts immediately, serial 3 leaves a
    // gap, so the driver awaits a (deliberately blocked) move-history GATT write.
    state.notify(gen4Moves([1, 3]));
    await tick();
    // The history response arrives while that write is still pending.
    state.notify(gen4History(3, 2));
    await tick();
    releaseWrite();
    await tick();
    await tick();

    expect(serials).toEqual([1, 2, 3]);
    await conn.disconnect();
  });
});

describe('GanCubeClassicConnection notification-chain resilience', () => {
  it('keeps processing later notifications after a validator throws (no poisoned chain)', async () => {
    const command = new MockCharacteristic();
    const state = new MockCharacteristic();
    const device = new EventTarget();

    let first = true;
    const throwingValidator = (): boolean => {
      if (first) {
        first = false;
        throw new Error('validator defect');
      }
      return true;
    };

    const conn = await GanCubeClassicConnection.create(
      device as unknown as BluetoothDevice,
      command as unknown as BluetoothRemoteGATTCharacteristic,
      state as unknown as BluetoothRemoteGATTCharacteristic,
      identity,
      new GanGen4ProtocolDriver(),
      { validateDecrypted: throwingValidator }
    );

    const events: GanCubeEvent[] = [];
    conn.events$.subscribe((e: GanCubeEvent) => events.push(e));

    // First frame makes the validator throw; the chain must survive it.
    state.notify(gen4Facelets(0));
    await tick();
    // Second frame must still be decoded and emitted.
    state.notify(gen4Facelets(1));
    await tick();
    await tick();

    expect(events.some((e) => e.type === 'FACELETS')).toBe(true);
    await conn.disconnect();
  });
});
