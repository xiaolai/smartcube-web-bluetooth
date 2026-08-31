
import { Observable } from 'rxjs';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, SmartCubeProtocolInfo, SmartCubeSnapshot, MacAddressProvider } from '../types';
import { SmartCubeEventBus } from '../event-bus';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { resolveCubeMac } from '../attachment/resolve-mac';
import { throwIfAborted } from '../attachment/abort';
import { createMoyu32SessionCrypto, type Moyu32SessionCrypto } from '../attachment/moyu32-session-crypto';
import { buildMoyu32MacCandidatesFromName } from '../attachment/mac-candidates';
import { probeMoyu32Mac } from '../attachment/mac-probe-moyu32';
import { SmartCubeProtocol, SmartCubeNameFilter, deviceNameMatchesFilters, registerProtocol } from '../protocol';
import { CubieCube, SOLVED_FACELET, moveDirectionFromNotation } from '../cubie-cube';
import { now, findCharacteristic } from '../ble-utils';
import { writeGattCharacteristicValue } from '../../gatt-characteristic-write';

const SERVICE_UUID = '0783b03e-7735-b5a0-1760-a305d2795cb0';
const CHRT_UUID_READ = '0783b03e-7735-b5a0-1760-a305d2795cb1';
const CHRT_UUID_WRITE = '0783b03e-7735-b5a0-1760-a305d2795cb2';

/** Opcode 172 + payload to enable gyro notifications (MoYu WCU). */
const ENABLE_GYRO_PAYLOAD = Object.freeze([
    172, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]) as readonly number[];

/**
 * Parse 6 MAC octets from a manufacturer data DataView into canonical `aa:bb:…` form.
 * When length >= 8, the first two bytes are treated as company ID and skipped; the next six
 * are the cube address in LSB-first wire order (reversed into display order), matching key derivation.
 */
function moyu32MacColonFromManufacturerDataView(dv: DataView): string | null {
    const n = dv.byteLength;
    if (n < 6) {
        return null;
    }
    const skipCid = n >= 8 ? 2 : 0;
    if (n < skipCid + 6) {
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
        return moyu32MacColonFromManufacturerDataView(mfData);
    }
    for (const id of mfData.keys()) {
        const dataView = mfData.get(id);
        if (dataView) {
            const mac = moyu32MacColonFromManufacturerDataView(dataView);
            if (mac) {
                return mac;
            }
        }
    }
    return null;
}

function parseFacelet(faceletBits: string): string {
    const state: string[] = [];
    const faces = [2, 5, 0, 3, 4, 1]; // parse in order URFDLB instead of FBUDLR
    for (let i = 0; i < 6; i++) {
        const face = faceletBits.slice(faces[i] * 24, 24 + faces[i] * 24);
        for (let j = 0; j < 8; j++) {
            state.push("FBUDLR".charAt(parseInt(face.slice(j * 3, 3 + j * 3), 2)));
            if (j === 3) {
                state.push("FBUDLR".charAt(faces[i]));
            }
        }
    }
    return state.join('');
}

const MOYU32_PROTOCOL: SmartCubeProtocolInfo = { id: 'moyu32', name: 'MoYu32' };

class Moyu32Connection implements SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly protocol: SmartCubeProtocolInfo = MOYU32_PROTOCOL;
    private readonly bus = new SmartCubeEventBus({
        gyroscope: false,
        battery: true,
        facelets: true,
        hardware: true,
        reset: false
    });
    readonly events$: Observable<SmartCubeEvent> = this.bus.events$;
    readonly state$: Observable<SmartCubeSnapshot> = this.bus.state$;

    private device: BluetoothDevice;
    private readChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private writeChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private encrypter: Moyu32SessionCrypto | null = null;
    private prevCubie = new CubieCube();
    private curCubie = new CubieCube();
    private latestFacelet = SOLVED_FACELET;
    private deviceTime = 0;
    private deviceTimeOffset = 0;
    private moveCnt = -1;
    private prevMoveCnt = -1;
    private batteryInterval: ReturnType<typeof setInterval> | null = null;

    constructor(device: BluetoothDevice, mac: string) {
        this.device = device;
        this.deviceName = device.name || 'WCU_MY3';
        this.deviceMAC = mac;
    }

    get capabilities(): SmartCubeCapabilities {
        return this.bus.capabilities as SmartCubeCapabilities;
    }

    getSnapshot(): SmartCubeSnapshot {
        return this.bus.getSnapshot();
    }


    private sendRequest(req: number[]): Promise<void> {
        if (!this.writeChrct) return Promise.resolve();
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
        this.parseData(value);
    };

    private pollBattery = (): void => {
        void this.sendSimpleRequest(164);
    };

    private parseData(value: DataView): void {
        const timestamp = now();
        const raw: number[] = [];
        for (let i = 0; i < value.byteLength; i++) {
            raw[i] = value.getUint8(i);
        }
        const decoded = this.encrypter ? this.encrypter.decrypt(raw) : raw;

        if ((decoded[0] | 0) === 171) {
            if (!this.capabilities.gyroscope) {
                this.bus.setCapabilities({ gyroscope: true });
            }
            this.parseGyroData(decoded, timestamp);
            return;
        }

        const bits = decoded.map(b => ((b + 256) & 0xFF).toString(2).padStart(8, '0')).join('');
        const msgType = parseInt(bits.slice(0, 8), 2);

        if (msgType === 161) { // Hardware info
            let devName = '';
            for (let i = 0; i < 8; i++) {
                devName += String.fromCharCode(parseInt(bits.slice(8 + i * 8, 16 + i * 8), 2));
            }
            const hardwareVersion = parseInt(bits.slice(88, 96), 2) + "." + parseInt(bits.slice(96, 104), 2);
            const softwareVersion = parseInt(bits.slice(72, 80), 2) + "." + parseInt(bits.slice(80, 88), 2);

            this.bus.emit({
                timestamp,
                type: "HARDWARE",
                hardwareName: devName.trim(),
                softwareVersion,
                hardwareVersion,
                gyroSupported: this.capabilities.gyroscope
            });
        } else if (msgType === 163) { // Facelets state
            const seq = parseInt(bits.slice(152, 160), 2);
            const facelet = parseFacelet(bits.slice(8, 152));
            if (this.prevCubie.fromFacelet(facelet) === -1) {
                return; // not a legal cube state (wrong key or corrupt frame): keep the previous state
            }
            this.latestFacelet = facelet;
            this.moveCnt = seq;
            this.prevMoveCnt = seq;

            this.bus.emit({
                timestamp,
                type: "FACELETS",
                facelets: this.latestFacelet
            });
        } else if (msgType === 164) { // Battery
            this.bus.emitBattery(parseInt(bits.slice(8, 16), 2), timestamp);
        } else if (msgType === 165) { // Move
            this.moveCnt = parseInt(bits.slice(88, 96), 2);
            if (this.moveCnt === this.prevMoveCnt || this.prevMoveCnt === -1) return;

            const prevMoves: string[] = [];
            const timeOffs: number[] = [];
            let invalidMove = false;
            for (let i = 0; i < 5; i++) {
                const m = parseInt(bits.slice(96 + i * 5, 101 + i * 5), 2);
                timeOffs[i] = parseInt(bits.slice(8 + i * 16, 24 + i * 16), 2);
                prevMoves[i] = "FBUDLR".charAt(m >> 1) + " '".charAt(m & 1);
                if (m >= 12) {
                    prevMoves[i] = "U ";
                    invalidMove = true;
                }
            }

            if (!invalidMove) {
                const rawDelta = (this.moveCnt - this.prevMoveCnt) & 0xff;
                if (rawDelta > prevMoves.length) {
                    console.warn('[Moyu32] lost move events', rawDelta - prevMoves.length);
                }
                const moveDiff = Math.min(rawDelta, prevMoves.length);
                this.prevMoveCnt = this.moveCnt;

                let calcTs = this.deviceTime + this.deviceTimeOffset;
                for (let i = moveDiff - 1; i >= 0; i--) {
                    calcTs += timeOffs[i];
                }
                if (!this.deviceTime || Math.abs(timestamp - calcTs) > 2000) {
                    this.deviceTime += timestamp - calcTs;
                }

                for (let i = moveDiff - 1; i >= 0; i--) {
                    const moveNotation = prevMoves[i].trim();
                    const m = "URFDLB".indexOf(moveNotation[0]) * 3 + " 2'".indexOf(moveNotation[1] || ' ');

                    CubieCube.CubeMult(this.prevCubie, CubieCube.moveCube[m], this.curCubie);
                    this.deviceTime += timeOffs[i];

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
        }
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

    private onDisconnect = (): void => {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.bus.resetBatteryDedupe();
        if (this.batteryInterval) {
            clearInterval(this.batteryInterval);
            this.batteryInterval = null;
        }
        this.bus.emit({ timestamp: now(), type: "DISCONNECT" });
        this.bus.complete();
    };

    async init(): Promise<void> {
        this.device.addEventListener('gattserverdisconnected', this.onDisconnect);
        const gatt = await this.device.gatt!.connect();
        const service = await gatt.getPrimaryService(SERVICE_UUID);
        const chrcts = await service.getCharacteristics();
        this.readChrct = findCharacteristic(chrcts, CHRT_UUID_READ);
        this.writeChrct = findCharacteristic(chrcts, CHRT_UUID_WRITE);

        if (!this.readChrct || !this.writeChrct) {
            throw new Error('[Moyu32] Cannot find read/write characteristics');
        }

        this.readChrct.addEventListener('characteristicvaluechanged', this.onStateChanged);
        await this.readChrct.startNotifications();

        // Initialize encryption with MAC (shared with the MAC probe, so both always agree)
        this.encrypter = createMoyu32SessionCrypto(this.deviceMAC);

        await this.sendSimpleRequest(161); // Request cube info
        await this.sendSimpleRequest(163); // Request cube status (facelets)
        await this.sendSimpleRequest(164); // Request battery level

        // Some MoYu32 variants require an extra request burst before
        // gyro enable + steady-state status updates begin.
        await this.sendSimpleRequest(161);
        await this.sendSimpleRequest(163);
        await this.sendSimpleRequest(164);

        this.batteryInterval = setInterval(this.pollBattery, 60_000);
        await this.sendRequest(Array.from(ENABLE_GYRO_PAYLOAD));
        await this.sendSimpleRequest(163); // Refresh cube status after enabling gyro notifications
    }

    async sendCommand(command: SmartCubeCommand): Promise<void> {
        switch (command.type) {
            case "REQUEST_HARDWARE":
                await this.sendSimpleRequest(161);
                break;
            case "REQUEST_FACELETS":
                await this.sendSimpleRequest(163);
                break;
            case "REQUEST_BATTERY":
                this.bus.forceNextBattery();
                await this.sendSimpleRequest(164);
                break;
        }
    }

    async disconnect(): Promise<void> {
        if (this.readChrct) {
            this.readChrct.removeEventListener('characteristicvaluechanged', this.onStateChanged);
            await this.readChrct.stopNotifications().catch(() => {});
            this.readChrct = null;
        }
        this.bus.resetBatteryDedupe();
        if (this.batteryInterval) {
            clearInterval(this.batteryInterval);
            this.batteryInterval = null;
        }
        this.writeChrct = null;
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.bus.emit({ timestamp: now(), type: "DISCONNECT" });
        this.bus.complete();
        if (this.device.gatt?.connected) {
            this.device.gatt.disconnect();
        }
    }
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

const MOYU32_NAME_FILTERS: SmartCubeNameFilter[] = [{ namePrefix: '^S' }, { namePrefix: 'WCU_' }, { namePrefix: 'WCU_MY3' }];

const moyu32Protocol: SmartCubeProtocol = {
    nameFilters: MOYU32_NAME_FILTERS,
    optionalServices: [SERVICE_UUID],
    needsMac: true,

    matchesDevice: deviceNameMatchesFilters(MOYU32_NAME_FILTERS),

    gattAffinity(serviceUuids: ReadonlySet<string>, _device: BluetoothDevice): number {
        return serviceUuids.has(normalizeUuid(SERVICE_UUID)) ? 110 : 0;
    },

    connect: connectMoyu32Device
};

registerProtocol(moyu32Protocol);

export { moyu32Protocol };
