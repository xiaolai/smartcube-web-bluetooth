
import { SmartCubeConnection, SmartCubeCommand, SmartCubeCapabilities, SmartCubeProtocolInfo, MacAddressProvider } from '../types';
import { GattSmartCubeConnection } from '../gatt-connection';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { resolveCubeMac } from '../attachment/resolve-mac';
import { parseMoyu32FaceletBits as parseFacelet } from '../attachment/moyu32-facelets';
import { throwIfAborted } from '../attachment/abort';
import { createMoyu32SessionCrypto, type Moyu32SessionCrypto } from '../attachment/moyu32-session-crypto';
import { buildMoyu32MacCandidatesFromName } from '../attachment/mac-candidates';
import { probeMoyu32Mac } from '../attachment/mac-probe-moyu32';
import { SmartCubeProtocol, SmartCubeNameFilter, deviceNameMatchesFilters, registerProtocol } from '../protocol';
import { CubieCube, moveDirectionFromNotation } from '../cubie-cube';
import { findCharacteristic } from '../ble-utils';
import { now } from '../../utils';
import { writeGattCharacteristicValue } from '../../gatt-characteristic-write';
import { MOYU32_READ_CHARACTERISTIC, MOYU32_SERVICE, MOYU32_WRITE_CHARACTERISTIC } from '../gatt-uuids';

// SUPERSEDED: UUIDs come from smartcube/gatt-uuids.ts, the single source for every brand.
// const SERVICE_UUID = '0783b03e-7735-b5a0-1760-a305d2795cb0';
// const CHRT_UUID_READ = '0783b03e-7735-b5a0-1760-a305d2795cb1';
// const CHRT_UUID_WRITE = '0783b03e-7735-b5a0-1760-a305d2795cb2';

/** Opcode 172 + payload to enable gyro notifications (MoYu WCU). */
const ENABLE_GYRO_PAYLOAD = Object.freeze([
    172, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]) as readonly number[];

/** MoYu32 wire opcodes (requests and their notification responses share the value). */
const OP_HARDWARE_INFO = 161;
const OP_FACELETS = 163;
const OP_BATTERY = 164;
const OP_MOVE = 165;
const OP_GYRO = 171;

/**
 * Parse 6 MAC octets into canonical `aa:bb:…` form. The six bytes at `skipCid` are the
 * cube address in LSB-first wire order (reversed into display order, matching key
 * derivation).
 */
function moyu32MacColonFromManufacturerDataView(dv: DataView, skipCid: number): string | null {
    if (dv.byteLength < skipCid + 6) {
        return null;
    }
    const parts: string[] = [];
    for (let i = 0; i < 6; i++) {
        parts.push((dv.getUint8(skipCid + 5 - i) + 0x100).toString(16).slice(1));
    }
    return parts.join(':');
}

function parseMoyu32MacFromMf(mfData: BluetoothManufacturerData | DataView | null): string | null {
    if (!mfData) {
        return null;
    }
    if (mfData instanceof DataView) {
        // Raw advertisement blob: a company-ID prefix precedes the address when present.
        return moyu32MacColonFromManufacturerDataView(mfData, mfData.byteLength >= 8 ? 2 : 0);
    }
    // The Web Bluetooth spec says map values exclude the company ID, which argues for
    // never skipping bytes here — but upstream's skip-2-when-longer heuristic was
    // field-tested against real MoYu32 hardware, so it is kept until a real captured
    // advertisement settles the layout. MoYu's company IDs are undocumented, so every
    // entry is tried; a wrong candidate cannot stick because the MAC is only cached
    // after decrypted traffic proves it.
    for (const id of mfData.keys()) {
        const dataView = mfData.get(id);
        if (dataView) {
            const mac = moyu32MacColonFromManufacturerDataView(dataView, dataView.byteLength >= 8 ? 2 : 0);
            if (mac) {
                return mac;
            }
        }
    }
    return null;
}

const MOYU32_PROTOCOL: SmartCubeProtocolInfo = { id: 'moyu32', name: 'MoYu32' };

const MOYU32_CAPABILITIES: SmartCubeCapabilities = {
    gyroscope: false,
    battery: true,
    facelets: true,
    hardware: true,
    reset: false
};

class Moyu32Connection extends GattSmartCubeConnection {
    private readChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private writeChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private encrypter: Moyu32SessionCrypto | null = null;
    private prevCubie = new CubieCube();
    private curCubie = new CubieCube();
    private deviceTime = 0;
    private deviceTimeOffset = 0;
    private prevMoveCnt = -1;

    constructor(device: BluetoothDevice, mac: string) {
        super(device, MOYU32_PROTOCOL, device.name || 'WCU_MY3', mac, MOYU32_CAPABILITIES);
    }

    // SUPERSEDED: the bus facade, device and lifecycle live in GattSmartCubeConnection.
    // readonly deviceName: string;
    // readonly deviceMAC: string;
    // readonly protocol: SmartCubeProtocolInfo = MOYU32_PROTOCOL;
    // private readonly bus = new SmartCubeEventBus({ ...MOYU32_CAPABILITIES });
    // readonly events$: Observable<SmartCubeEvent> = this.bus.events$;
    // readonly state$: Observable<SmartCubeSnapshot> = this.bus.state$;
    // private device: BluetoothDevice;
    // private batteryInterval: ReturnType<typeof setInterval> | null = null;
    // constructor(device: BluetoothDevice, mac: string) {
    //     this.device = device;
    //     this.deviceName = device.name || 'WCU_MY3';
    //     this.deviceMAC = mac;
    // }
    // get capabilities(): SmartCubeCapabilities {
    //     return this.bus.capabilities as SmartCubeCapabilities;
    // }
    // getSnapshot(): SmartCubeSnapshot {
    //     return this.bus.getSnapshot();
    // }

    private sendRequest(req: number[]): Promise<void> {
        if (!this.writeChrct) {
            // Reject loudly: a command after disconnect (or before init) must not look
            // like success.
            return Promise.reject(new Error('[Moyu32] Not connected'));
        }
        const encoded = this.encrypter ? this.encrypter.encrypt(req.slice()) : req;
        return writeGattCharacteristicValue(this.writeChrct, new Uint8Array(encoded).buffer).then(() => {});
    }

    private sendSimpleRequest(opcode: number): Promise<void> {
        const req = new Array(20).fill(0);
        req[0] = opcode;
        return this.sendRequest(req);
    }

    private onStateChanged = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value || !this.encrypter) return;
        if (value.byteLength !== 20) return; // MoYu32 frames are exactly 20 bytes; drop malformed ones
        this.parseData(value);
    };

    private pollBattery = (): void => {
        this.sendSimpleRequest(OP_BATTERY).catch(() => {
            // periodic poll: transient write failures are retried on the next tick
        });
    };

    private parseData(value: DataView): void {
        const timestamp = now();
        const raw: number[] = [];
        for (let i = 0; i < value.byteLength; i++) {
            raw[i] = value.getUint8(i);
        }
        const decoded = this.encrypter ? this.encrypter.decrypt(raw) : raw;

        if ((decoded[0] | 0) === OP_GYRO) {
            if (!this.capabilities.gyroscope) {
                this.bus.setCapabilities({ gyroscope: true });
            }
            this.parseGyroData(decoded, timestamp);
            return;
        }

        const bits = decoded.map(b => ((b + 256) & 0xFF).toString(2).padStart(8, '0')).join('');
        const msgType = parseInt(bits.slice(0, 8), 2);

        if (msgType === OP_HARDWARE_INFO) {
            this.handleHardwareInfo(bits, timestamp);
        } else if (msgType === OP_FACELETS) {
            this.handleFacelets(bits, timestamp);
        } else if (msgType === OP_BATTERY) {
            this.bus.emitBattery(parseInt(bits.slice(8, 16), 2), timestamp);
        } else if (msgType === OP_MOVE) {
            this.handleMoves(bits, timestamp);
        }
    }

    private handleHardwareInfo(bits: string, timestamp: number): void {
        let devName = '';
        for (let i = 0; i < 8; i++) {
            devName += String.fromCharCode(parseInt(bits.slice(8 + i * 8, 16 + i * 8), 2));
        }
        const hardwareVersion = parseInt(bits.slice(88, 96), 2) + "." + parseInt(bits.slice(96, 104), 2);
        const softwareVersion = parseInt(bits.slice(72, 80), 2) + "." + parseInt(bits.slice(80, 88), 2);

        this.bus.emit({
            timestamp,
            type: "HARDWARE",
            // The 8-byte field is NUL-padded; trim() alone leaves embedded NULs behind.
            hardwareName: devName.split('\0')[0]!.trim(),
            softwareVersion,
            hardwareVersion,
            gyroSupported: this.capabilities.gyroscope
        });
    }

    private handleFacelets(bits: string, timestamp: number): void {
        const seq = parseInt(bits.slice(152, 160), 2);
        const facelet = parseFacelet(bits.slice(8, 152));
        if (this.prevCubie.fromFacelet(facelet) === -1) {
            return; // not a legal cube state (wrong key or corrupt frame): keep the previous state
        }
        this.prevMoveCnt = seq;

        this.bus.emit({
            timestamp,
            type: "FACELETS",
            facelets: facelet
        });
    }

    private handleMoves(bits: string, timestamp: number): void {
        const moveCnt = parseInt(bits.slice(88, 96), 2);
        if (this.prevMoveCnt === -1) {
            // Moves arrived before any facelet packet seeded the tracker: adopt the
            // counter and resynchronize instead of discarding every move forever.
            this.prevMoveCnt = moveCnt;
            this.sendSimpleRequest(OP_FACELETS).catch(() => {});
            return;
        }
        if (moveCnt === this.prevMoveCnt) return;

        const rawDelta = (moveCnt - this.prevMoveCnt) & 0xff;
        if (rawDelta > 5) {
            console.warn('[Moyu32] lost move events', rawDelta - 5);
        }
        const moveDiff = Math.min(rawDelta, 5);

        // Validate only the history entries the counter delta actually requires: a
        // filler in an unused slot must not discard valid current moves.
        const prevMoves: string[] = [];
        const timeOffs: number[] = [];
        for (let i = 0; i < moveDiff; i++) {
            const m = parseInt(bits.slice(96 + i * 5, 101 + i * 5), 2);
            timeOffs[i] = parseInt(bits.slice(8 + i * 16, 24 + i * 16), 2);
            if (m >= 12) {
                // A required entry is unusable: the sequence cannot be applied safely.
                // Adopt the counter and resynchronize the state instead.
                this.prevMoveCnt = moveCnt;
                this.sendSimpleRequest(OP_FACELETS).catch(() => {});
                return;
            }
            prevMoves[i] = "FBUDLR".charAt(m >> 1) + " '".charAt(m & 1);
        }
        this.prevMoveCnt = moveCnt;

        let calcTs = this.deviceTime + this.deviceTimeOffset;
        for (let i = moveDiff - 1; i >= 0; i--) {
            calcTs += timeOffs[i]!;
        }
        if (!this.deviceTime || Math.abs(timestamp - calcTs) > 2000) {
            this.deviceTime += timestamp - calcTs;
        }

        for (let i = moveDiff - 1; i >= 0; i--) {
            const moveNotation = prevMoves[i]!.trim();
            const m = "URFDLB".indexOf(moveNotation[0]!) * 3 + " 2'".indexOf(moveNotation[1] || ' ');

            CubieCube.CubeMult(this.prevCubie, CubieCube.moveCube[m]!, this.curCubie);
            this.deviceTime += timeOffs[i]!;

            const face = Math.floor(m / 3);
            const direction = moveDirectionFromNotation(moveNotation);

            this.bus.emit({
                timestamp,
                type: "MOVE",
                face,
                direction,
                move: moveNotation,
                localTimestamp: i === 0 ? timestamp : null,
                cubeTimestamp: this.deviceTime
            });

            this.bus.emit({
                timestamp,
                type: "FACELETS",
                facelets: this.curCubie.toFaceCube()
            });

            const tmp = this.curCubie;
            this.curCubie = this.prevCubie;
            this.prevCubie = tmp;
        }
        this.deviceTimeOffset = timestamp - this.deviceTime;
    }

    private parseGyroData(decoded: number[], timestamp: number): void {
        const dv = new DataView(Uint8Array.from(decoded).buffer);
        const scale = 1073741824; // 2^30
        let w = dv.getInt32(1, true) / scale;
        let x = dv.getInt32(5, true) / scale;
        let y = dv.getInt32(9, true) / scale;
        let z = dv.getInt32(13, true) / scale;

        const len = Math.hypot(w, x, y, z);
        if (len > 0) {
            w /= len;
            x /= len;
            y /= len;
            z /= len;
        }

        this.bus.emit({
            timestamp,
            type: "GYRO",
            quaternion: { x, y, z, w }
        });
    }

    protected override releaseResources(): void {
        if (this.readChrct) {
            this.readChrct.removeEventListener('characteristicvaluechanged', this.onStateChanged);
            this.readChrct = null;
        }
        this.writeChrct = null;
        this.encrypter = null;
    }

    // SUPERSEDED: GattSmartCubeConnection.teardown() runs releaseResources() at the same point in the same order.
    // /** Idempotent teardown shared by remote and explicit disconnects. */
    // private teardown(): void {
    //     this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
    //     if (this.readChrct) {
    //         this.readChrct.removeEventListener('characteristicvaluechanged', this.onStateChanged);
    //         this.readChrct = null;
    //     }
    //     this.writeChrct = null;
    //     this.encrypter = null;
    //     this.bus.resetBatteryDedupe();
    //     if (this.batteryInterval) {
    //         clearInterval(this.batteryInterval);
    //         this.batteryInterval = null;
    //     }
    //     this.bus.emit({ timestamp: now(), type: "DISCONNECT" });
    //     this.bus.complete();
    // }
    //
    // private onDisconnect = (): void => {
    //     this.teardown();
    // };
    /** Hardware, facelets, and battery requests in the order the cube expects. */
    private async sendInitBurst(): Promise<void> {
        await this.sendSimpleRequest(OP_HARDWARE_INFO);
        await this.sendSimpleRequest(OP_FACELETS);
        await this.sendSimpleRequest(OP_BATTERY);
    }

    async init(): Promise<void> {
        await this.initialize(async () => {
            const gatt = await this.device.gatt!.connect();
            const service = await gatt.getPrimaryService(MOYU32_SERVICE);
            const chrcts = await service.getCharacteristics();
            this.readChrct = findCharacteristic(chrcts, MOYU32_READ_CHARACTERISTIC);
            this.writeChrct = findCharacteristic(chrcts, MOYU32_WRITE_CHARACTERISTIC);

            if (!this.readChrct || !this.writeChrct) {
                throw new Error('[Moyu32] Cannot find read/write characteristics');
            }

            // Session crypto must exist before notifications are enabled: frames
            // delivered during startNotifications() were silently dropped otherwise.
            this.encrypter = createMoyu32SessionCrypto(this.deviceMAC);

            this.readChrct.addEventListener('characteristicvaluechanged', this.onStateChanged);
            await this.readChrct.startNotifications();

            await this.sendInitBurst();
            // Some MoYu32 variants require an extra request burst before
            // gyro enable + steady-state status updates begin.
            await this.sendInitBurst();

            this.startBatteryPolling(this.pollBattery);
            await this.sendRequest(Array.from(ENABLE_GYRO_PAYLOAD));
            await this.sendSimpleRequest(OP_FACELETS); // Refresh cube status after enabling gyro notifications
        });
        // SUPERSEDED: GattSmartCubeConnection.initialize() owns the disconnect hook and the failure path.
        // this.device.addEventListener('gattserverdisconnected', this.onDisconnect);
        // try {
        // } catch (e) {
        //     this.teardown();
        //     if (this.device.gatt?.connected) {
        //         this.device.gatt.disconnect();
        //     }
        //     throw e;
        // }
    }

    override async sendCommand(command: SmartCubeCommand): Promise<void> {
        switch (command.type) {
            case "REQUEST_HARDWARE":
                await this.sendSimpleRequest(OP_HARDWARE_INFO);
                break;
            case "REQUEST_FACELETS":
                await this.sendSimpleRequest(OP_FACELETS);
                break;
            case "REQUEST_BATTERY":
                this.bus.forceNextBattery();
                try {
                    await this.sendSimpleRequest(OP_BATTERY);
                } catch (e) {
                    this.bus.cancelForcedBattery();
                    throw e;
                }
                break;
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

async function connectMoyu32Device(
    device: BluetoothDevice,
    macProvider?: MacAddressProvider,
    context?: AttachmentContext
): Promise<SmartCubeConnection> {
    throwIfAborted(context?.signal);
    const mac = await resolveCubeMac(device, macProvider, context, {
        parseFromManufacturerData: parseMoyu32MacFromMf,
        advertisementTimeoutsMs: [5000, 8000],
        candidatesFromName: buildMoyu32MacCandidatesFromName,
        probe: probeMoyu32Mac,
        probeTimeoutMs: 2000,
    });

    if (!mac) {
        throw new Error('Unable to determine MoYu32 cube MAC address');
    }

    const conn = new Moyu32Connection(device, mac);
    await conn.init();
    return conn;
}

// '^S' (a literal caret prefix no device name can start with) and 'WCU_MY3' (subsumed
// by 'WCU_') were provably dead entries; whether upstream meant '^S' as a regex for
// names starting with S remains a hardware question.
const MOYU32_NAME_FILTERS: SmartCubeNameFilter[] = [{ namePrefix: 'WCU_' }];

const moyu32Protocol: SmartCubeProtocol = {
    nameFilters: MOYU32_NAME_FILTERS,
    optionalServices: [MOYU32_SERVICE],
    needsMac: true,

    matchesDevice: deviceNameMatchesFilters(MOYU32_NAME_FILTERS),

    gattAffinity(serviceUuids: ReadonlySet<string>, _device: BluetoothDevice): number {
        return serviceUuids.has(normalizeUuid(MOYU32_SERVICE)) ? 110 : 0;
    },

    connect: connectMoyu32Device
};

registerProtocol(moyu32Protocol);

export { moyu32Protocol };
