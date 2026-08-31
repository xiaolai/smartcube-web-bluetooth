import aesjs from 'aes-js';
import type { AES } from 'aes-js';
import { Subject } from 'rxjs';
import * as def from './gan-cube-definitions';
import type { GanCubeCommand, GanCubeConnection, GanCubeEvent, GanCubeState } from './gan-cube-protocol';
import { now } from './utils';
import { CubieCube, moveDirectionFromNotation } from './smartcube/cubie-cube';

type AesBlockCipher = AES & { decrypt(block: number[]): number[] };

/** Firmware acceptance: major byte 0x01 (bits 9-23 must equal 0x010000), minimum 0x010007. */
const GEN1_FW_MASK = 0xFFFE00;
const GEN1_FW_EXPECTED = 0x010000;
const GEN1_FW_MIN = 0x010007;
/** The FFF5 physical-state frame is exactly 19 bytes (gyro, move counter, move codes). */
const GEN1_STATE_FRAME_LENGTH = 19;
/** The FFF6 timing frame carries nine 16-bit values read through byte index 18. */
const GEN1_TIMING_FRAME_LENGTH = 19;
/** The FFF2 facelet frame carries six 3-byte faces. */
const GEN1_FACELETS_FRAME_LENGTH = 18;
const GEN1_POLL_INTERVAL_MS = 30;
const GEN1_BATTERY_INTERVAL_MS = 60_000;
/** Give up and disconnect after this many consecutive poll failures (~bounded minutes). */
const GEN1_MAX_POLL_FAILURES = 50;
/** Reconcile facelets from the cube after this many observed moves. */
const GEN1_MOVES_PER_STATE_REFRESH = 20;

class GanGen1Aes {
    private readonly aes: AesBlockCipher;

    constructor(keyBytes: Uint8Array) {
        this.aes = new aesjs.AES([...keyBytes]) as AesBlockCipher;
    }

    /** Two overlapping ECB blocks: the tail 16 bytes first, then the head 16 bytes. */
    decrypt(data: Uint8Array): Uint8Array {
        if (data.length < 16) throw new Error('Invalid data length');
        const bytes = Array.from(data);
        if (bytes.length > 16) {
            const tailOffset = bytes.length - 16;
            const tailPlain = this.aes.decrypt(bytes.slice(tailOffset, tailOffset + 16));
            for (let i = 0; i < 16; i++) bytes[tailOffset + i] = tailPlain[i]!;
        }
        const headPlain = this.aes.decrypt(bytes.slice(0, 16));
        for (let i = 0; i < 16; i++) bytes[i] = headPlain[i]!;
        return new Uint8Array(bytes);
    }
}

/** Key table index is the firmware "major" byte; unknown majors are rejected (a wrong key would silently decrypt garbage). */
export function deriveGen1Key(fwVersion: number, hw: DataView): Uint8Array | null {
    const idx = (fwVersion >> 8) & 255;
    const table = def.GAN_GEN1_KEYS[idx];
    if (!table || hw.byteLength < 6) return null;
    const arr = Array.from(table);
    for (let s = 0; s < 6; s++) {
        arr[s] = (arr[s]! + hw.getUint8(5 - s)) & 255;
    }
    return new Uint8Array(arr.slice(0, 16));
}

/**
 * Three signed 14-bit-scaled components; w is reconstructed from the unit-quaternion
 * invariant. Axis mapping (x,y,z) = (-raw1, raw2, -raw0) matches the field-tested
 * cubing.js gen1 driver.
 */
function gyroFromState(state: Uint8Array): { x: number; y: number; z: number; w: number } | null {
    if (state.length < 6) return null;
    let raw0 = state[0]! | (state[1]! << 8);
    let raw1 = state[2]! | (state[3]! << 8);
    let raw2 = state[4]! | (state[5]! << 8);
    if (raw0 > 32767) raw0 -= 65536;
    if (raw1 > 32767) raw1 -= 65536;
    if (raw2 > 32767) raw2 -= 65536;
    const n0 = raw0 / 16384;
    const n1 = raw1 / 16384;
    const n2 = raw2 / 16384;
    const wSquared = 1 - n0 * n0 - n1 * n1 - n2 * n2;
    return { x: -n1, y: n2, z: -n0, w: wSquared > 0 ? Math.sqrt(wSquared) : 0 };
}

/** Six faces of eight 3-bit stickers each (bytes pair-swapped on the wire); centers are implied. */
function parseGen1Facelets(bytes: Uint8Array): string {
    const out: string[] = [];
    for (let i = 0; i < bytes.length - 2; i += 3) {
        const faceBits = (bytes[1 ^ i]! << 16) | (bytes[(i + 1) ^ 1]! << 8) | bytes[(i + 2) ^ 1]!;
        for (let shift = 21; shift >= 0; shift -= 3) {
            out.push('URFDLB'.charAt((faceBits >> shift) & 7));
            if (shift === 12) out.push('URFDLB'.charAt(i / 3));
        }
    }
    return out.join('');
}

/** Derive the cubie-level state from a parsed facelet string; null when not a legal state. */
function cubieStateFromFacelets(facelets: string): GanCubeState | null {
    const cubie = new CubieCube().fromFacelet(facelets);
    if (cubie === -1) {
        return null;
    }
    return {
        CP: cubie.ca.map((v) => v & 7),
        CO: cubie.ca.map((v) => v >> 3),
        EP: cubie.ea.map((v) => v >> 1),
        EO: cubie.ea.map((v) => v & 1),
    };
}

/**
 * GAN 356i “API v1”: primary service `fff0` + Device Information for key derivation.
 */
export class GanGen1CubeConnection implements GanCubeConnection {
    readonly deviceMAC = '';

    readonly events$: Subject<GanCubeEvent>;

    private readonly encrypter: GanGen1Aes;
    private readonly device: BluetoothDevice;
    private readonly chrState: BluetoothRemoteGATTCharacteristic;
    private readonly chrMoves: BluetoothRemoteGATTCharacteristic;
    private readonly chrFacelets: BluetoothRemoteGATTCharacteristic;
    private readonly chrBattery: BluetoothRemoteGATTCharacteristic;
    /** Optional: not all gen1 profiles expose FFF4; gyro then comes from the polled FFF5 frames. */
    private readonly chrGyroNotify: BluetoothRemoteGATTCharacteristic | null;

    private polling = false;
    private prevMoveCnt = -1;
    private movesSinceStateRefresh = 0;
    private nextBatteryReadAt = 0;
    private pollFailures = 0;
    private teardown = false;
    private lastBatteryLevel: number | null = null;
    private forceNextBatteryEmission = false;
    /** Serializes every GATT read: explicit commands must not overlap the poll loop. */
    private gattChain: Promise<unknown> = Promise.resolve();

    private readonly onGattDisconnected: () => void;

    private constructor(
        device: BluetoothDevice,
        encrypter: GanGen1Aes,
        events$: Subject<GanCubeEvent>,
        chrState: BluetoothRemoteGATTCharacteristic,
        chrMoves: BluetoothRemoteGATTCharacteristic,
        chrFacelets: BluetoothRemoteGATTCharacteristic,
        chrBattery: BluetoothRemoteGATTCharacteristic,
        chrGyroNotify: BluetoothRemoteGATTCharacteristic | null
    ) {
        this.device = device;
        this.encrypter = encrypter;
        this.events$ = events$;
        this.chrState = chrState;
        this.chrMoves = chrMoves;
        this.chrFacelets = chrFacelets;
        this.chrBattery = chrBattery;
        this.chrGyroNotify = chrGyroNotify;

        this.onGattDisconnected = () => void this.handleDisconnect();
        this.device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    }

    get deviceName(): string {
        return this.device.name || 'GAN356i v1';
    }

    static async create(device: BluetoothDevice, externalEvents$?: Subject<GanCubeEvent>): Promise<GanGen1CubeConnection> {
        const gatt = device.gatt;
        if (!gatt?.connected) {
            throw new Error('GATT must be connected before GAN gen1 setup');
        }

        const deviceInfo = await gatt.getPrimaryService(def.GAN_GEN1_DEVICE_INFO_SERVICE);
        const fwChar = await deviceInfo.getCharacteristic(def.GAN_GEN1_CHR_FIRMWARE);
        const hwChar = await deviceInfo.getCharacteristic(def.GAN_GEN1_CHR_HARDWARE);
        const fw = await fwChar.readValue();
        const n =
            fw.byteLength >= 3
                ? (fw.getUint8(0) << 16) | (fw.getUint8(1) << 8) | fw.getUint8(2)
                : 0;
        if (!(n > GEN1_FW_MIN && (GEN1_FW_MASK & n) === GEN1_FW_EXPECTED)) {
            throw new Error(`Invalid firmware version: 0x${n.toString(16)}`);
        }
        const hwRaw = await hwChar.readValue();
        const keyArr = deriveGen1Key(n, hwRaw);
        if (!keyArr) {
            throw new Error(`Unsupported gen1 firmware key index 0x${((n >> 8) & 255).toString(16)}`);
        }

        const encrypter = new GanGen1Aes(keyArr);
        const primary = await gatt.getPrimaryService(def.GAN_GEN1_PRIMARY_SERVICE);
        const chrState = await primary.getCharacteristic(def.GAN_GEN1_CHR_STATE);
        const chrMoves = await primary.getCharacteristic(def.GAN_GEN1_CHR_MOVES);
        const chrFacelets = await primary.getCharacteristic(def.GAN_GEN1_CHR_FACELETS);
        const chrBattery = await primary.getCharacteristic(def.GAN_GEN1_CHR_BATTERY);
        // FFF4 is not part of every gen1 profile (the reference implementation does not
        // use it at all): feature-detect instead of failing the whole connection.
        const chrGyroNotify = await primary.getCharacteristic(def.GAN_GEN1_CHR_GYRO_NOTIFY).catch(() => null);

        const events$ = externalEvents$ ?? new Subject<GanCubeEvent>();
        const conn = new GanGen1CubeConnection(
            device,
            encrypter,
            events$,
            chrState,
            chrMoves,
            chrFacelets,
            chrBattery,
            chrGyroNotify
        );

        try {
            if (chrGyroNotify) {
                chrGyroNotify.addEventListener('characteristicvaluechanged', conn.onGyroNotify);
                await chrGyroNotify.startNotifications();
            }
            // Initial state and battery are part of setup: their failure fails create().
            await conn.readInitialState(false);
            await conn.readBattery(false);
        } catch (e) {
            conn.device.removeEventListener('gattserverdisconnected', conn.onGattDisconnected);
            if (chrGyroNotify) {
                chrGyroNotify.removeEventListener('characteristicvaluechanged', conn.onGyroNotify);
                await chrGyroNotify.stopNotifications().catch(() => {});
            }
            throw e;
        }
        conn.polling = true;
        conn.nextBatteryReadAt = now() + GEN1_BATTERY_INTERVAL_MS;
        conn.schedulePoll(0);

        return conn;
    }

    private onGyroNotify = (evt: Event): void => {
        try {
            const chr = evt.target as BluetoothRemoteGATTCharacteristic;
            const e = chr.value;
            if (!e || e.byteLength < 16) return;
            const dec = this.encrypter.decrypt(new Uint8Array(e.buffer, e.byteOffset, e.byteLength));
            const q = gyroFromState(dec);
            if (q) {
                this.events$.next({ type: 'GYRO', timestamp: now(), quaternion: q });
            }
        } catch {
            /* corrupt frame */
        }
    };

    /**
     * Battery dedupe mirrors the shared event-bus policy on purpose: this legacy
     * connection is also used standalone, without a bus in front of it.
     */
    private emitBatteryLevel(rawLevel: number, timestamp = now()): void {
        if (!Number.isFinite(rawLevel)) {
            return;
        }
        const batteryLevel = Math.min(100, Math.max(0, Math.round(rawLevel)));
        const forceEmission = this.forceNextBatteryEmission;
        this.forceNextBatteryEmission = false;
        if (!forceEmission && this.lastBatteryLevel === batteryLevel) {
            return;
        }
        this.lastBatteryLevel = batteryLevel;
        this.events$.next({
            type: 'BATTERY',
            batteryLevel,
            timestamp,
        });
    }

    /** All GATT reads are funneled through one chain so operations never overlap. */
    private readDecrypted(chr: BluetoothRemoteGATTCharacteristic, minLength: number): Promise<Uint8Array | null> {
        const run = async (): Promise<Uint8Array | null> => {
            if (this.teardown) {
                throw new Error('GAN gen1 connection is closed');
            }
            const e = await chr.readValue();
            const t = this.encrypter.decrypt(new Uint8Array(e.buffer, e.byteOffset, e.byteLength));
            return t.length >= minLength ? t : null;
        };
        const result = this.gattChain.then(run, run);
        this.gattChain = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    private async readBattery(swallowErrors: boolean): Promise<void> {
        try {
            const t = await this.readDecrypted(this.chrBattery, 8);
            if (!t) return;
            this.emitBatteryLevel(t[7]!);
        } catch (e) {
            if (!swallowErrors) throw e;
        }
    }

    private async readInitialState(swallowErrors: boolean): Promise<void> {
        try {
            const t = await this.readDecrypted(this.chrFacelets, GEN1_FACELETS_FRAME_LENGTH);
            if (!t) return;
            const facelets = parseGen1Facelets(t);
            const state = cubieStateFromFacelets(facelets);
            if (!state) {
                if (!swallowErrors) throw new Error('GAN gen1 returned an invalid facelet state');
                return; // corrupt read during polling: keep the previous state
            }
            this.events$.next({
                timestamp: now(),
                type: 'FACELETS',
                serial: this.prevMoveCnt >= 0 ? this.prevMoveCnt : 0,
                facelets,
                state,
            });
        } catch (e) {
            if (!swallowErrors) throw e;
        }
    }

    private schedulePoll(delayMs: number): void {
        if (!this.polling || this.teardown) return;
        setTimeout(() => void this.pollLoop(), delayMs);
    }

    private async pollLoop(): Promise<void> {
        if (!this.polling || this.teardown) return;
        try {
            const t = await this.readDecrypted(this.chrState, GEN1_STATE_FRAME_LENGTH);
            this.pollFailures = 0;
            if (t) {
                await this.handleStateFrame(t);
            }
            if (now() >= this.nextBatteryReadAt) {
                this.nextBatteryReadAt = now() + GEN1_BATTERY_INTERVAL_MS;
                await this.readBattery(true);
            }
            this.schedulePoll(GEN1_POLL_INTERVAL_MS);
        } catch {
            this.pollFailures++;
            if (this.pollFailures >= GEN1_MAX_POLL_FAILURES) {
                // A wedged GATT session must not silently stop producing data forever
                // while reporting itself healthy.
                void this.handleDisconnect();
                return;
            }
            const wait = Math.min(500 * 2 ** Math.min(this.pollFailures, 4), 2000);
            this.schedulePoll(wait);
        }
    }

    private async handleStateFrame(t: Uint8Array): Promise<void> {
        // Gyro data lives in the state frame; use it only when FFF4 notifications are
        // not available, so orientation is never emitted from two sources at once.
        if (!this.chrGyroNotify) {
            const q = gyroFromState(t);
            if (q) {
                this.events$.next({ type: 'GYRO', timestamp: now(), quaternion: q });
            }
        }
        const moveCnt = t[12]!;
        if (this.prevMoveCnt === -1) {
            this.prevMoveCnt = moveCnt;
            return;
        }
        if (moveCnt === this.prevMoveCnt) {
            return;
        }
        let o = (moveCnt - this.prevMoveCnt) & 255;
        if (o > 6) o = 6;
        const moves: string[] = [];
        let corrupt = false;
        for (let l = 0; l < 6; l++) {
            const u = t[13 + l]!;
            if (u >= 18) {
                corrupt = true;
            }
            moves.unshift('URFDLB'.charAt(~~(u / 3)) + " 2'".charAt(u % 3));
        }
        this.prevMoveCnt = moveCnt;
        if (corrupt) {
            // An out-of-range move code means the frame (or key) is unreliable:
            // resynchronize the state instead of inventing moves.
            await this.readInitialState(true);
            return;
        }
        const mt = await this.readDecrypted(this.chrMoves, GEN1_TIMING_FRAME_LENGTH);
        const stamps: number[] = [];
        if (mt) {
            for (let r = 0; r < 9; r++) {
                stamps.unshift(mt[2 * r + 1]! | (mt[2 * r + 2]! << 8));
            }
        }
        const ts = now();
        for (let r = o - 1; r >= 0; r--) {
            const d = moves[r]?.trim();
            if (!d) continue;
            const f = 'URFDLB'.indexOf(d[0]!);
            const h = moveDirectionFromNotation(d);
            this.events$.next({
                timestamp: ts,
                type: 'MOVE',
                serial: (moveCnt - r) & 255,
                face: f,
                direction: h,
                move: d,
                cubeTimestamp: stamps[r] ?? null,
                // Only the newest move was actually observed at this host time.
                localTimestamp: r === 0 ? ts : null,
            });
        }
        this.movesSinceStateRefresh += o;
        if (this.movesSinceStateRefresh >= GEN1_MOVES_PER_STATE_REFRESH) {
            this.movesSinceStateRefresh = 0;
            await this.readInitialState(true);
        }
    }

    private async handleDisconnect(): Promise<void> {
        if (this.teardown) return;
        this.teardown = true;
        this.polling = false;
        this.lastBatteryLevel = null;
        this.forceNextBatteryEmission = false;
        this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
        if (this.chrGyroNotify) {
            try {
                this.chrGyroNotify.removeEventListener('characteristicvaluechanged', this.onGyroNotify);
                await this.chrGyroNotify.stopNotifications().catch(() => {});
            } catch {
                /* ignore */
            }
        }
        this.events$.next({ timestamp: now(), type: 'DISCONNECT' });
        this.events$.complete();
    }

    async sendCubeCommand(command: GanCubeCommand): Promise<void> {
        switch (command.type) {
            case 'REQUEST_BATTERY':
                this.forceNextBatteryEmission = true;
                try {
                    await this.readBattery(false);
                } catch (e) {
                    this.forceNextBatteryEmission = false;
                    throw e;
                }
                break;
            case 'REQUEST_FACELETS':
                await this.readInitialState(false);
                break;
            default:
                // Fail loud: gen1 has no hardware-info or reset command, and a silent
                // success would hide the capability mismatch from legacy callers.
                throw new Error(`GAN gen1 does not support ${command.type}`);
        }
    }

    async disconnect(): Promise<void> {
        await this.handleDisconnect();
        if (this.device.gatt?.connected) {
            this.device.gatt.disconnect();
        }
    }
}
