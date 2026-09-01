
import { SmartCubeConnection, SmartCubeCommand, SmartCubeProtocolInfo, MacAddressProvider } from '../types';
import { GattSmartCubeConnection } from '../gatt-connection';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { SmartCubeProtocol, SmartCubeNameFilter, deviceNameMatchesFilters, registerProtocol } from '../protocol';
import { abortError, throwIfAborted } from '../attachment/abort';
import { CubieCube, SOLVED_FACELET } from '../cubie-cube';
import { now } from '../../utils';
import { writeGattCharacteristicValue } from '../../gatt-characteristic-write';
import { GOCUBE_UART_READ_CHARACTERISTIC, GOCUBE_UART_SERVICE, GOCUBE_UART_WRITE_CHARACTERISTIC } from '../gatt-uuids';

// SUPERSEDED: UUIDs come from smartcube/gatt-uuids.ts, the single source for every brand.
// const UUID_SUFFIX = '-b5a3-f393-e0a9-e50e24dcca9e';
// const SERVICE_UUID = '6e400001' + UUID_SUFFIX;
// const CHRCT_UUID_WRITE = '6e400002' + UUID_SUFFIX;
// const CHRCT_UUID_READ = '6e400003' + UUID_SUFFIX;

const WRITE_BATTERY = 50;
const WRITE_STATE = 51;
const WRITE_RESET = 53;
/** Enable MsgOrientation (3D tracking). Rubik's Connected / GoCube X omit IMU; only classic GoCube uses this. */
const WRITE_ENABLE_ORIENTATION = 0x38;

const INITIAL_STATE_TIMEOUT_MS = 5000;

/** True for classic GoCube (incl. `GoCube_*`); false for Rubik's Connected and GoCube X (same UART, no gyro). */
function goCubeDeviceSupportsGyro(deviceName: string): boolean {
    if (!deviceName.startsWith('GoCube')) {
        return false;
    }
    if (deviceName.startsWith('GoCubeX')) {
        return false;
    }
    return true;
}

/** Sum of bytes 0..(checksum-1) mod 256 equals checksum byte (immediately before CRLF). */
function gocubeChecksumValid(value: DataView): boolean {
    if (value.byteLength < 7) {
        return false;
    }
    let sum = 0;
    for (let i = 0; i <= value.byteLength - 4; i++) {
        sum += value.getUint8(i);
    }
    return (sum & 0xff) === value.getUint8(value.byteLength - 3);
}

/**
 * MsgOrientation payload: ASCII decimals `x#y#z#w` (see public GoCube UART docs). Normalize to a unit quaternion.
 * Integer components are scaled together so normalization yields the physical orientation.
 *
 * Wire `(rx,ry,rz,rw)` normalized to `(nx,ny,nz,nw)` then mapped to `(nx, -nz, -ny, nw)`.
 */
export function parseGoCubeOrientationPayload(payloadUtf8: string): { x: number; y: number; z: number; w: number } | null {
    const parts = payloadUtf8.split('#');
    if (parts.length !== 4) {
        return null;
    }
    const rx = Number.parseInt(parts[0]!.trim(), 10);
    const ry = Number.parseInt(parts[1]!.trim(), 10);
    const rz = Number.parseInt(parts[2]!.trim(), 10);
    const rw = Number.parseInt(parts[3]!.trim(), 10);
    if (![rx, ry, rz, rw].every((n) => Number.isFinite(n))) {
        return null;
    }
    const len = Math.hypot(rx, ry, rz, rw);
    if (len === 0) {
        return null;
    }
    const nx = rx / len;
    const ny = ry / len;
    const nz = rz / len;
    const nw = rw / len;
    return { x: nx, y: -nz, z: -ny, w: nw };
}

const AXIS_PERM = [5, 2, 0, 3, 1, 4];
const FACE_PERM = [0, 1, 2, 5, 8, 7, 6, 3];
const FACE_OFFSET = [0, 0, 6, 2, 0, 0];

/** Physical opposite faces in URFDLB axis order (U↔D, R↔L, F↔B). */
const OPPOSITE_AXIS = [3, 4, 5, 0, 1, 2];

const GOCUBE_PROTOCOL: SmartCubeProtocolInfo = { id: 'gocube', name: 'GoCube' };

class GoCubeConnection extends GattSmartCubeConnection {
    private readChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private writeChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private curCubie = new CubieCube();
    private prevCubie = new CubieCube();
    private moveCntFree = 100;
    /** Last decoded move (axis + direction bit) for short type-1 frames that omit a full pair of bytes. */
    private lastMoveMeta: { axis: number; dirBit: number } | null = null;
    /** First full-state (type 2) after connect resolves the init wait; the bus snapshot preserves it for late subscribers. */
    private awaitingInitialState = false;
    private resolveInitialState: (() => void) | undefined;
    private rejectInitialState: ((e: Error) => void) | undefined;

    constructor(device: BluetoothDevice, name: string, gyroSupported: boolean) {
        super(device, GOCUBE_PROTOCOL, name, '', {
            gyroscope: gyroSupported,
            battery: true,
            facelets: true,
            hardware: true,
            reset: true
        });
    }

    // SUPERSEDED: the bus facade, device and lifecycle live in GattSmartCubeConnection.
    // readonly deviceName: string;
    // readonly deviceMAC: string;
    // readonly protocol: SmartCubeProtocolInfo = GOCUBE_PROTOCOL;
    // private readonly bus: SmartCubeEventBus;
    // readonly events$: Observable<SmartCubeEvent>;
    // readonly state$: Observable<SmartCubeSnapshot>;
    // private device: BluetoothDevice;
    // private batteryInterval: ReturnType<typeof setInterval> | null = null;
    // constructor(device: BluetoothDevice, name: string, gyroSupported: boolean) {
    //     this.device = device;
    //     this.deviceName = name;
    //     this.deviceMAC = '';
    //     this.bus = new SmartCubeEventBus({ gyroscope: gyroSupported, battery: true, facelets: true, hardware: true, reset: true });
    //     this.events$ = this.bus.events$;
    //     this.state$ = this.bus.state$;
    // }
    // get capabilities(): SmartCubeCapabilities {
    //     return this.bus.capabilities as SmartCubeCapabilities;
    // }
    // getSnapshot(): SmartCubeSnapshot {
    //     return this.bus.getSnapshot();
    // }

    private onStateChanged = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        this.parseData(value);
    };

    private applySingleMove(timestamp: number, axis: number, dirBit: number): void {
        const power = [0, 2][dirBit];
        const m = axis * 3 + power;
        const moveStr = ("URFDLB".charAt(axis) + " 2'".charAt(power)).trim();

        CubieCube.CubeMult(this.prevCubie, CubieCube.moveCube[m], this.curCubie);
        const facelet = this.curCubie.toFaceCube();

        this.bus.emit({
            timestamp,
            type: "MOVE",
            face: axis,
            direction: power === 0 ? 0 : 1,
            move: moveStr,
            localTimestamp: timestamp,
            cubeTimestamp: null
        });

        this.bus.emit({
            timestamp,
            type: "FACELETS",
            facelets: facelet
        });

        const tmp = this.curCubie;
        this.curCubie = this.prevCubie;
        this.prevCubie = tmp;

        if (++this.moveCntFree > 20) {
            this.moveCntFree = 0;
            if (this.writeChrct) {
                writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_STATE]).buffer).catch(() => {});
            }
        }
    }

    private pollBattery = (): void => {
        if (!this.writeChrct) {
            return;
        }
        writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_BATTERY]).buffer).catch(() => {});
    };

    private requestStateResync(): void {
        if (this.writeChrct) {
            writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_STATE]).buffer).catch(() => {});
        }
    }

    private parseData(value: DataView): void {
        const timestamp = now();
        if (value.byteLength < 4) return;
        if (value.getUint8(0) !== 0x2a ||
            value.getUint8(value.byteLength - 2) !== 0x0d ||
            value.getUint8(value.byteLength - 1) !== 0x0a) {
            return;
        }
        // Full frames include a checksum byte before CRLF; short type-1 move frames may be smaller.
        if (value.byteLength >= 7) {
            // Byte 1 declares byteLength - 2 on every real frame (verified against captures).
            if (value.getUint8(1) !== value.byteLength - 2) {
                return;
            }
            if (!gocubeChecksumValid(value)) {
                return;
            }
        }

        const msgType = value.getUint8(2);
        const msgLen = value.byteLength - 6;
        if (msgType !== 1 && value.byteLength < 7) {
            return; // only truncated move frames may arrive below checksummable size
        }

        if (msgType === 3) {
            // MsgOrientation: ASCII x#y#z#w between byte 3 and checksum.
            if (!this.capabilities.gyroscope || value.byteLength < 8) {
                return;
            }
            const end = value.byteLength - 3;
            const payload = new Uint8Array(value.buffer, value.byteOffset + 3, end - 3);
            const text = new TextDecoder('utf-8', { fatal: false }).decode(payload);
            const q = parseGoCubeOrientationPayload(text);
            if (!q) {
                return;
            }
            this.bus.emit({
                timestamp,
                type: 'GYRO',
                quaternion: q
            });
            return;
        }

        if (msgType === 1) { // Move
            // Firmware may send a truncated type-1 frame (< 8 bytes): treat as opposite-face turn,
            // mirroring the last full move.
            if (value.byteLength < 8) {
                if (this.lastMoveMeta) {
                    const oppAxis = OPPOSITE_AXIS[this.lastMoveMeta.axis];
                    const newDirBit = 1 - this.lastMoveMeta.dirBit;
                    this.applySingleMove(timestamp, oppAxis, newDirBit);
                    this.lastMoveMeta = { axis: oppAxis, dirBit: newDirBit };
                }
                return;
            }
            if (msgLen <= 0 || msgLen % 2 !== 0) {
                return; // moves come in 2-byte pairs; an odd tail byte is not a move
            }
            for (let i = 0; i < msgLen; i += 2) {
                const moveCode = value.getUint8(3 + i);
                if (moveCode >> 1 > 5) {
                    // Not a legal face code: the frame is corrupt, resynchronize instead of guessing.
                    this.requestStateResync();
                    return;
                }
                const axis = AXIS_PERM[moveCode >> 1];
                const dirBit = moveCode & 1;
                this.lastMoveMeta = { axis, dirBit };
                this.applySingleMove(timestamp, axis, dirBit);
            }
        } else if (msgType === 2) { // Cube state
            if (value.byteLength < 60) {
                return; // 54 sticker bytes + angles required; a short frame would read out of bounds
            }
            // Full-cube state is six 9-sticker faces in wire order; unpack with AXIS_PERM/FACE_PERM.
            const facelet: string[] = [];
            for (let a = 0; a < 6; a++) {
                const axis = AXIS_PERM[a] * 9;
                const aoff = FACE_OFFSET[a];
                facelet[axis + 4] = "BFUDRL".charAt(value.getUint8(3 + a * 9));
                for (let i = 0; i < 8; i++) {
                    facelet[axis + FACE_PERM[(i + aoff) % 8]] = "BFUDRL".charAt(value.getUint8(3 + a * 9 + i + 1));
                }
            }
            const newFacelet = facelet.join('');
            const curFacelet = this.prevCubie.toFaceCube();
            if (newFacelet !== curFacelet) {
                if (this.curCubie.fromFacelet(newFacelet) === -1) {
                    return; // not a legal cube state: keep the tracked state authoritative
                }
                const tmp = this.curCubie;
                this.curCubie = this.prevCubie;
                this.prevCubie = tmp;
            }
            if (this.awaitingInitialState && this.resolveInitialState) {
                const done = this.resolveInitialState;
                this.resolveInitialState = undefined;
                this.awaitingInitialState = false;
                done();
                return;
            }
            this.bus.emit({
                timestamp,
                type: "FACELETS",
                facelets: this.prevCubie.toFaceCube()
            });
        } else if (msgType === 5) { // Battery
            this.bus.emitBattery(value.getUint8(3), timestamp);
        }
    }

    // SUPERSEDED: GattSmartCubeConnection.emitHardwareEventFromName().
    // private emitHardwareEvent(): void {
    //     this.bus.emit({
    //         timestamp: now(),
    //         type: "HARDWARE",
    //         hardwareName: this.deviceName,
    //         gyroSupported: this.capabilities.gyroscope
    //     });
    // }
    protected override releaseResources(): void {
        if (this.readChrct) {
            this.readChrct.removeEventListener('characteristicvaluechanged', this.onStateChanged);
            this.readChrct = null;
        }
        this.writeChrct = null;
        const rejectInit = this.rejectInitialState;
        this.rejectInitialState = undefined;
        this.resolveInitialState = undefined;
        this.awaitingInitialState = false;
        rejectInit?.(new Error('GoCube disconnected during initialization'));
    }

    // SUPERSEDED: GattSmartCubeConnection.teardown() runs releaseResources() at the same point in the same order. Rejecting the init promise before the DISCONNECT emit is preserved; its handlers run on a later microtask either way.
    // /** Idempotent teardown shared by remote and explicit disconnects. */
    // private teardown(): void {
    //     this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
    //     if (this.readChrct) {
    //         this.readChrct.removeEventListener('characteristicvaluechanged', this.onStateChanged);
    //         this.readChrct = null;
    //     }
    //     this.writeChrct = null;
    //     this.bus.resetBatteryDedupe();
    //     if (this.batteryInterval) {
    //         clearInterval(this.batteryInterval);
    //         this.batteryInterval = null;
    //     }
    //     const rejectInit = this.rejectInitialState;
    //     this.rejectInitialState = undefined;
    //     this.resolveInitialState = undefined;
    //     this.awaitingInitialState = false;
    //     rejectInit?.(new Error('GoCube disconnected during initialization'));
    //     this.bus.emit({ timestamp: now(), type: "DISCONNECT" });
    //     this.bus.complete();
    // }
    //
    // private onDisconnect = (): void => {
    //     this.teardown();
    // };
    async init(): Promise<void> {
        // Failure handling stays in connect(): it disconnects through the full path so a
        // half-started notification stream is stopped, not just dropped.
        this.watchDisconnect();
        const gatt = await this.device.gatt!.connect();
        const service = await gatt.getPrimaryService(GOCUBE_UART_SERVICE);
        this.writeChrct = await service.getCharacteristic(GOCUBE_UART_WRITE_CHARACTERISTIC);
        this.readChrct = await service.getCharacteristic(GOCUBE_UART_READ_CHARACTERISTIC);
        await this.readChrct.startNotifications();
        this.readChrct.addEventListener('characteristicvaluechanged', this.onStateChanged);

        if (this.capabilities.gyroscope) {
            await writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_ENABLE_ORIENTATION]).buffer).catch(() => {});
        }

        const firstStatePromise = new Promise<void>((resolve, reject) => {
            this.resolveInitialState = resolve;
            this.rejectInitialState = reject;
        });
        this.awaitingInitialState = true;

        await writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_STATE]).buffer);
        this.pollBattery();
        this.startBatteryPolling(this.pollBattery);

        let initialStateTimer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
            // A disconnect during the wait rejects firstStatePromise and fails init.
            await Promise.race([
                firstStatePromise,
                new Promise<void>((resolve) => {
                    initialStateTimer = setTimeout(() => {
                        timedOut = true;
                        resolve();
                    }, INITIAL_STATE_TIMEOUT_MS);
                })
            ]);
        } finally {
            clearTimeout(initialStateTimer);
            this.awaitingInitialState = false;
            this.resolveInitialState = undefined;
            this.rejectInitialState = undefined;
        }

        if (timedOut) {
            // The cube never reported its state: leave the snapshot's facelets unknown
            // instead of presenting the default solved state as if the cube had said so.
            return;
        }
        // Emit the initial state synchronously: live subscribers cannot exist yet, but the
        // bus snapshot preserves it for state$/getSnapshot().
        this.bus.emit({
            timestamp: now(),
            type: "FACELETS",
            facelets: this.prevCubie.toFaceCube()
        });
    }

    override async sendCommand(command: SmartCubeCommand): Promise<void> {
        if (!this.writeChrct) {
            return;
        }
        if (command.type === "REQUEST_BATTERY") {
            this.bus.forceNextBattery();
            await writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_BATTERY]).buffer);
        } else if (command.type === "REQUEST_FACELETS") {
            // Tracker-based cube: report the tracked state immediately (the documented
            // semantics for GoCube), then poll the device so a later type-2 frame corrects it.
            const ts = now();
            this.bus.emit({
                timestamp: ts,
                type: "FACELETS",
                facelets: this.prevCubie.toFaceCube()
            });
            await writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_STATE]).buffer);
        } else if (command.type === "REQUEST_HARDWARE") {
            this.emitHardwareEventFromName();
        } else if (command.type === "REQUEST_RESET") {
            await writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_RESET]).buffer);
            this.curCubie = new CubieCube();
            this.prevCubie = new CubieCube();
            this.lastMoveMeta = null;
            this.moveCntFree = 100;
            this.bus.resetBatteryDedupe();
            this.bus.emit({
                timestamp: now(),
                type: "FACELETS",
                facelets: SOLVED_FACELET
            });
        }
    }

    protected override notifyingCharacteristics(): (BluetoothRemoteGATTCharacteristic | null)[] {
        return [this.readChrct];
    }

    // SUPERSEDED: GattSmartCubeConnection.disconnect() stops notifyingCharacteristics() and drops the GATT link.
    // async disconnect(): Promise<void> {
    //     const readChrct = this.readChrct;
    //     this.teardown();
    //     if (readChrct) {
    //         await readChrct.stopNotifications().catch(() => {});
    //     }
    //     if (this.device.gatt?.connected) {
    //         this.device.gatt.disconnect();
    //     }
    // }
}

const GOCUBE_NAME_FILTERS: SmartCubeNameFilter[] = [
    { namePrefix: 'GoCube' },
    { namePrefix: 'Rubiks' },
];

const goCubeProtocol: SmartCubeProtocol = {
    nameFilters: GOCUBE_NAME_FILTERS,
    optionalServices: [GOCUBE_UART_SERVICE],

    matchesDevice: deviceNameMatchesFilters(GOCUBE_NAME_FILTERS),

    gattAffinity(serviceUuids: ReadonlySet<string>, _device: BluetoothDevice): number {
        return serviceUuids.has(normalizeUuid(GOCUBE_UART_SERVICE)) ? 110 : 0;
    },

    async connect(
        device: BluetoothDevice,
        _macProvider?: MacAddressProvider,
        context?: AttachmentContext
    ): Promise<SmartCubeConnection> {
        throwIfAborted(context?.signal);
        const raw = device.name ?? '';
        const name = raw.startsWith('GoCube') ? 'GoCube' : 'Rubiks Connected';
        const conn = new GoCubeConnection(device, name, goCubeDeviceSupportsGyro(raw));
        try {
            await conn.init();
        } catch (e) {
            await conn.disconnect().catch(() => {});
            throw e;
        }
        if (context?.signal?.aborted) {
            await conn.disconnect().catch(() => {});
            throw abortError();
        }
        return conn;
    }
};

registerProtocol(goCubeProtocol);

export { goCubeProtocol };
