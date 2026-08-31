
import { Observable } from 'rxjs';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, SmartCubeProtocolInfo, SmartCubeSnapshot, MacAddressProvider } from '../types';
import { SmartCubeEventBus } from '../event-bus';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { SmartCubeProtocol, SmartCubeNameFilter, deviceNameMatchesFilters, registerProtocol } from '../protocol';
import { CubieCube, SOLVED_FACELET } from '../cubie-cube';
import { now, findCharacteristic } from '../ble-utils';
import {
    MoyuV1Client,
    moyuStickersToFaceletString,
    MOYU_V1_SOLVED_STICKERS,
} from './moyu-v1';

const UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const SERVICE_UUID = '00001000' + UUID_SUFFIX;
const CHRCT_UUID_WRITE = '00001001' + UUID_SUFFIX;
const CHRCT_UUID_READ = '00001002' + UUID_SUFFIX;
const CHRCT_UUID_TURN = '00001003' + UUID_SUFFIX;
const CHRCT_UUID_GYRO = '00001004' + UUID_SUFFIX;

const FACE_ORDER_LEN = 6;
const DEVICE_FACE_TO_AXIS = [3, 4, 5, 1, 2, 0] as const;

function normalizeQuaternion(q: { w: number; x: number; y: number; z: number }): {
    w: number;
    x: number;
    y: number;
    z: number;
} {
    const n = Math.hypot(q.w, q.x, q.y, q.z) || 1;
    return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
}

const MOYU_MHC_PROTOCOL: SmartCubeProtocolInfo = { id: 'moyu-mhc', name: 'MoYu MHC' };

class MoyuMhcConnection implements SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly protocol: SmartCubeProtocolInfo = MOYU_MHC_PROTOCOL;
    private readonly bus = new SmartCubeEventBus({
        gyroscope: false,
        battery: false,
        facelets: false,
        hardware: false,
        reset: false,
    });
    readonly events$: Observable<SmartCubeEvent> = this.bus.events$;
    readonly state$: Observable<SmartCubeSnapshot> = this.bus.state$;

    private device: BluetoothDevice;
    private writeChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private readChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private turnChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private gyroChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private v1: MoyuV1Client | null = null;
    private faceStatus = [0, 0, 0, 0, 0, 0];
    private curCubie = new CubieCube();
    private prevCubie = new CubieCube();
    private batteryInterval: ReturnType<typeof setInterval> | null = null;

    constructor(device: BluetoothDevice) {
        this.device = device;
        this.deviceName = device.name || 'MHC';
        this.deviceMAC = '';
    }

    get capabilities(): SmartCubeCapabilities {
        return this.bus.capabilities as SmartCubeCapabilities;
    }

    getSnapshot(): SmartCubeSnapshot {
        return this.bus.getSnapshot();
    }


    private onTurnEvent = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        this.parseTurn(value);
    };

    private onReadEvent = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value || !this.v1) return;
        this.v1.onReadNotification(value);
    };

    private onGyroEvent = (event: Event): void => {
        const e = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!e || e.byteLength < 20) return;
        const fw = e.getFloat32(4, true);
        const fx = e.getFloat32(8, true);
        const fy = e.getFloat32(12, true);
        const fz = e.getFloat32(16, true);
        if (![fw, fx, fy, fz].every(Number.isFinite) || Math.hypot(fw, fx, fy, fz) < 1e-6) {
            return; // corrupt sample: normalizing it would fabricate an orientation
        }
        const quaternion = normalizeQuaternion({
            w: fw,
            x: fx,
            y: -fy,
            z: fz,
        });
        const timestamp = now();
        this.bus.emit({
            timestamp,
            type: 'GYRO',
            quaternion,
        });
    };

    /**
     * After each move, `prevCubie` holds the latest physical state (see parseTurn swap).
     * Seed that cube from the device facelet string and align turn counters with gyro angles.
     */
    private applyCubeStateFromDevice(stickers: number[][], angles: number[]): boolean {
        const facelet = moyuStickersToFaceletString(stickers);
        const parsed = new CubieCube().fromFacelet(facelet);
        if (parsed === -1) {
            // Invalid device payload: keep the last known state authoritative instead of
            // silently pretending the cube is solved.
            return false;
        }
        this.prevCubie = parsed;
        this.curCubie = new CubieCube();
        for (let i = 0; i < FACE_ORDER_LEN; i++) {
            this.faceStatus[i] = (angles[i] ?? 0) % 9;
        }
        return true;
    }

    private parseTurn(data: DataView): void {
        const timestamp = now();
        if (data.byteLength < 1) return;
        const nMoves = data.getUint8(0);
        if (data.byteLength < 1 + nMoves * 6) return;

        for (let i = 0; i < nMoves; i++) {
            const offset = 1 + i * 6;
            // >>> 0 keeps the assembled 32-bit value unsigned past the halfway point of
            // the cube clock's range.
            const rawTs = (data.getUint8(offset + 1) << 24
                | data.getUint8(offset + 0) << 16
                | data.getUint8(offset + 3) << 8
                | data.getUint8(offset + 2)) >>> 0;
            const ts = Math.round(rawTs / 65536 * 1000);

            const face = data.getUint8(offset + 4);
            if (face >= FACE_ORDER_LEN) continue;

            const dir = Math.round(data.getInt8(offset + 5) / 36);
            const prevRot = this.faceStatus[face]!;
            const curRot = this.faceStatus[face]! + dir;
            this.faceStatus[face] = (curRot + 9) % 9;

            const axis = DEVICE_FACE_TO_AXIS[face]!;
            let pow: number;
            if (prevRot >= 5 && curRot <= 4) {
                pow = 2;
            } else if (prevRot <= 4 && curRot >= 5) {
                pow = 0;
            } else {
                continue;
            }

            const m = axis * 3 + pow;
            const moveStr = ("URFDLB".charAt(axis) + " 2'".charAt(pow)).trim();

            CubieCube.CubeMult(this.prevCubie, CubieCube.moveCube[m]!, this.curCubie);
            const faceletStr = this.curCubie.toFaceCube();

            this.bus.emit({
                timestamp,
                type: "MOVE",
                face: axis,
                direction: pow === 0 ? 0 : 1,
                move: moveStr,
                localTimestamp: timestamp,
                cubeTimestamp: ts
            });

            this.bus.emit({
                timestamp,
                type: "FACELETS",
                facelets: faceletStr
            });

            const tmp = this.curCubie;
            this.curCubie = this.prevCubie;
            this.prevCubie = tmp;
        }
    }

    private async pollBattery(): Promise<void> {
        if (!this.v1) {
            return;
        }
        try {
            const b = await this.v1.getBatteryInfo();
            this.bus.emitBattery(b.value.percentage);
        } catch {
            /* ignore failed optional commands */
        }
    }

    /** Idempotent teardown shared by remote and explicit disconnects. */
    private teardown(): void {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        if (this.readChrct) {
            this.readChrct.removeEventListener('characteristicvaluechanged', this.onReadEvent);
            this.readChrct = null;
        }
        if (this.turnChrct) {
            this.turnChrct.removeEventListener('characteristicvaluechanged', this.onTurnEvent);
            this.turnChrct = null;
        }
        if (this.gyroChrct) {
            this.gyroChrct.removeEventListener('characteristicvaluechanged', this.onGyroEvent);
            this.gyroChrct = null;
        }
        this.writeChrct = null;
        this.v1?.dispose();
        this.v1 = null;
        this.bus.resetBatteryDedupe();
        if (this.batteryInterval) {
            clearInterval(this.batteryInterval);
            this.batteryInterval = null;
        }
        this.bus.emit({ timestamp: now(), type: "DISCONNECT" });
        this.bus.complete();
    }

    private onDisconnect = (): void => {
        this.teardown();
    };

    private updateCapabilities(): void {
        const hasV1 = this.v1 !== null;
        this.bus.setCapabilities({
            gyroscope: this.gyroChrct !== null,
            battery: hasV1,
            // Turn tracking also reports facelets, not just the v1 state read.
            facelets: hasV1 || this.turnChrct !== null,
            hardware: hasV1,
            reset: hasV1,
        });
    }

    async init(): Promise<void> {
        this.device.addEventListener('gattserverdisconnected', this.onDisconnect);
        try {
            const gatt = await this.device.gatt!.connect();
            const service = await gatt.getPrimaryService(SERVICE_UUID);
            const chrcts = await service.getCharacteristics();

            this.writeChrct = findCharacteristic(chrcts, CHRCT_UUID_WRITE);
            this.readChrct = findCharacteristic(chrcts, CHRCT_UUID_READ);
            this.turnChrct = findCharacteristic(chrcts, CHRCT_UUID_TURN);
            this.gyroChrct = findCharacteristic(chrcts, CHRCT_UUID_GYRO);

            // Every v1 command needs a response on the read characteristic; a
            // write-only client would advertise capabilities it cannot serve.
            if (this.writeChrct && this.readChrct) {
                this.v1 = new MoyuV1Client(this.writeChrct);
            }
            if (!this.v1 && !this.turnChrct) {
                throw new Error('MoYu MHC: no usable protocol path (need turn notifications or the v1 read/write pair)');
            }

            if (this.readChrct) {
                this.readChrct.addEventListener('characteristicvaluechanged', this.onReadEvent);
                await this.readChrct.startNotifications();
            }

            // Synchronize the cube state BEFORE enabling turn notifications, so moves
            // cannot be decoded against an unseeded tracker and then overwritten.
            if (this.v1) {
                try {
                    const st = await this.v1.getCubeState();
                    if (this.applyCubeStateFromDevice(st.stickers, st.angles)) {
                        this.bus.emit({
                            timestamp: now(),
                            type: 'FACELETS',
                            facelets: this.prevCubie.toFaceCube(),
                        });
                    }
                } catch {
                    // State unavailable: leave the snapshot's facelets unknown rather
                    // than fabricating a solved state.
                }
            }

            if (this.turnChrct) {
                this.turnChrct.addEventListener('characteristicvaluechanged', this.onTurnEvent);
                await this.turnChrct.startNotifications();
            }

            if (this.gyroChrct) {
                this.gyroChrct.addEventListener('characteristicvaluechanged', this.onGyroEvent);
                await this.gyroChrct.startNotifications();
            }

            this.updateCapabilities();

            if (this.v1) {
                await this.pollBattery();
                this.batteryInterval = setInterval(() => {
                    void this.pollBattery();
                }, 60_000);
            }
        } catch (e) {
            this.teardown();
            if (this.device.gatt?.connected) {
                this.device.gatt.disconnect();
            }
            throw e;
        }
    }

    async sendCommand(command: SmartCubeCommand): Promise<void> {
        if (!this.v1) return;

        // Failures propagate to the caller: a timed-out or rejected command must not
        // look like success. Timestamps are captured after the response arrives.
        if (command.type === 'REQUEST_FACELETS') {
            const st = await this.v1.getCubeState();
            if (!this.applyCubeStateFromDevice(st.stickers, st.angles)) {
                throw new Error('MoYu MHC: device returned an invalid cube state');
            }
            this.bus.emit({
                timestamp: now(),
                type: 'FACELETS',
                facelets: this.prevCubie.toFaceCube(),
            });
        } else if (command.type === 'REQUEST_BATTERY') {
            const b = await this.v1.getBatteryInfo();
            this.bus.forceNextBattery();
            this.bus.emitBattery(b.value.percentage, now());
        } else if (command.type === 'REQUEST_HARDWARE') {
            const h = await this.v1.getHardwareInfo();
            this.bus.emit({
                timestamp: now(),
                type: 'HARDWARE',
                hardwareName: this.deviceName,
                softwareVersion: `${h.major}.${h.minor}.${h.patch}`,
                gyroSupported: this.capabilities.gyroscope,
            });
        } else if (command.type === 'REQUEST_RESET') {
            await this.v1.setCubeState(MOYU_V1_SOLVED_STICKERS, [0, 0, 0, 0, 0, 0]);
            this.faceStatus = [0, 0, 0, 0, 0, 0];
            this.curCubie = new CubieCube();
            this.prevCubie = new CubieCube();
            this.bus.emit({
                timestamp: now(),
                type: 'FACELETS',
                facelets: SOLVED_FACELET,
            });
        }
    }

    async disconnect(): Promise<void> {
        const notifying = [this.readChrct, this.turnChrct, this.gyroChrct];
        this.teardown();
        for (const chrct of notifying) {
            if (chrct) {
                await chrct.stopNotifications().catch(() => {});
            }
        }
        if (this.device.gatt?.connected) {
            this.device.gatt.disconnect();
        }
    }
}

const MOYU_MHC_NAME_FILTERS: SmartCubeNameFilter[] = [{ namePrefix: 'MHC' }];

const moyuMhcProtocol: SmartCubeProtocol = {
    nameFilters: MOYU_MHC_NAME_FILTERS,
    optionalServices: [SERVICE_UUID],

    matchesDevice: deviceNameMatchesFilters(MOYU_MHC_NAME_FILTERS),

    gattAffinity(serviceUuids: ReadonlySet<string>, _device: BluetoothDevice): number {
        return serviceUuids.has(normalizeUuid(SERVICE_UUID)) ? 110 : 0;
    },

    async connect(
        device: BluetoothDevice,
        _macProvider?: MacAddressProvider,
        _context?: AttachmentContext
    ): Promise<SmartCubeConnection> {
        const conn = new MoyuMhcConnection(device);
        await conn.init();
        return conn;
    }
};

registerProtocol(moyuMhcProtocol);

export { moyuMhcProtocol };
