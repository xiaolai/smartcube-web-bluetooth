import { Observable } from 'rxjs';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, SmartCubeProtocolInfo, SmartCubeSnapshot, MacAddressProvider } from '../types';
import { SmartCubeEventBus } from '../event-bus';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { resolveCubeMac } from '../attachment/resolve-mac';
import { throwIfAborted } from '../attachment/abort';
import { parseMacBytes } from '../attachment/mac-address';
import { crc16modbus, decryptQiYiBlocks, encryptQiYiMessage, qiyiHelloContent } from '../attachment/qiyi-wire';
import { buildQiYiMacCandidatesFromName } from '../attachment/mac-candidates';
import { probeQiYiMac } from '../attachment/mac-probe-qiyi';
import { SmartCubeProtocol, SmartCubeNameFilter, deviceNameMatchesFilters, registerProtocol } from '../protocol';
import { CubieCube } from '../cubie-cube';
import { now, findCharacteristic, extractMacFromManufacturerData } from '../ble-utils';
import { writeGattCharacteristicValue } from '../../gatt-characteristic-write';

const UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const SERVICE_UUID = '0000fff0' + UUID_SUFFIX;
const CHRCT_UUID_CUBE = '0000fff6' + UUID_SUFFIX;

const QIYI_CIC_LIST = [0x0504];
/** Kociemba facelet string for solved cube */
const QIYI_SOLVED_FACELETS = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

/** QiYi frame opcodes. */
const OP_STATE_HELLO = 0x2;
const OP_STATE_CHANGE = 0x3;
const OP_SYNC_CONFIRM = 0x4;
/** Quaternion packets use their own header instead of the 0xFE frame. */
const QUATERNION_HEADER = 0xcc;
/** Device timestamps tick at 1.6 units per millisecond. */
const QIYI_TICKS_PER_MS = 1.6;

function parseFacelet(faceMsg: number[]): string {
    const ret: string[] = [];
    for (let i = 0; i < 54; i++) {
        ret.push("LRDUFB".charAt((faceMsg[i >> 1] >> ((i % 2) << 2)) & 0xf));
    }
    return ret.join("");
}

/** Device timestamps in bytes 3–6 and history slots: big-endian uint32 */
function readQiYiTimestampBE(msg: number[], offset: number): number {
    return (msg[offset]! << 24) | (msg[offset + 1]! << 16) | (msg[offset + 2]! << 8) | msg[offset + 3]!;
}

/** Collect primary + all 11 history slots (bytes 36..90) */
function collectQiYiStateChangeMoves(msg: number[], headerTs: number): [number, number][] {
    const out: [number, number][] = [[msg[34]!, headerTs]];
    for (let i = 0; i < 11; i++) {
        const off = 36 + 5 * i;
        if (off + 5 > msg.length) break;
        let allFf = true;
        for (let j = 0; j < 5; j++) {
            if (msg[off + j] !== 0xff) {
                allFf = false;
                break;
            }
        }
        if (allFf) continue;
        const slotTs = readQiYiTimestampBE(msg, off);
        const code = msg[off + 4]!;
        out.push([code, slotTs]);
    }
    out.sort((a, b) => a[1] - b[1]);
    const seen = new Set<string>();
    return out.filter(([code, t]) => {
        const k = `${code},${t}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

const QIYI_PROTOCOL: SmartCubeProtocolInfo = { id: 'qiyi', name: 'QiYi' };

class QiYiConnection implements SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly protocol: SmartCubeProtocolInfo = QIYI_PROTOCOL;
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
    private cubeChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private curCubie = new CubieCube();
    private prevCubie = new CubieCube();
    private lastTs = 0;
    private writeChain: Promise<void> = Promise.resolve();

    constructor(device: BluetoothDevice, mac: string) {
        this.device = device;
        this.deviceName = device.name || 'QiYi';
        this.deviceMAC = mac;
    }

    get capabilities(): SmartCubeCapabilities {
        return this.bus.capabilities as SmartCubeCapabilities;
    }

    getSnapshot(): SmartCubeSnapshot {
        return this.bus.getSnapshot();
    }


    private sendMessage(content: number[]): Promise<void> {
        if (!this.cubeChrct) return Promise.reject(new Error('[QiYi] Not connected'));
        const ch = this.cubeChrct;
        const run = async (): Promise<void> => {
            await writeGattCharacteristicValue(ch, encryptQiYiMessage(content));
        };
        this.writeChain = this.writeChain.then(run, run);
        return this.writeChain;
    }

    private sendHello(): Promise<void> {
        return this.sendMessage(qiyiHelloContent(parseMacBytes(this.deviceMAC)));
    }

    private onCubeEvent = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        // AES-ECB ciphertext is always whole 16-byte blocks; anything else is a truncated frame.
        if (!value || value.byteLength === 0 || value.byteLength % 16 !== 0) return;

        const raw = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const msg = Array.from(decryptQiYiBlocks(raw));

        if (msg[0] === QUATERNION_HEADER && msg[1] === 0x10) {
            this.handleQuaternionPacket(msg);
            return;
        }

        const trimmed = msg.slice(0, msg[1]);
        if (trimmed.length < 3 || crc16modbus(trimmed) !== 0) {
            return;
        }

        this.parseCubeData(trimmed);
    };

    private handleQuaternionPacket(msg: number[]): void {
        if (msg.length < 16) return;

        const expectedCrc = crc16modbus(msg.slice(0, 14));
        const actualCrc = msg[14] | (msg[15] << 8);
        if (expectedCrc !== actualCrc) return;

        if (!this.capabilities.gyroscope) {
            this.bus.setCapabilities({ gyroscope: true });
        }

        const dv = new DataView(Uint8Array.from(msg).buffer);
        const ax = dv.getInt16(6, false) / 1000;
        const ay = dv.getInt16(8, false) / 1000;
        const az = dv.getInt16(10, false) / 1000;
        const aw = dv.getInt16(12, false) / 1000;

        this.bus.emit({
            timestamp: now(),
            type: "GYRO",
            quaternion: {
                x: ax,
                y: -az,
                z: ay,
                w: aw
            }
        });
    }

    private emitHardwareEvent(): void {
        this.bus.emit({
            timestamp: now(),
            type: "HARDWARE",
            hardwareName: this.deviceName,
            gyroSupported: this.capabilities.gyroscope
        });
    }

    private parseCubeData(msg: number[]): void {
        const timestamp = now();
        if (msg[0] !== 0xfe) return;

        const opcode = msg[2]!;
        const ts = readQiYiTimestampBE(msg, 3);

        if (opcode === OP_STATE_HELLO) {
            // Hello response — always ACK
            this.sendMessage(msg.slice(2, 7)).catch(() => {});
            const newFacelet = parseFacelet(msg.slice(7, 34));
            if (this.prevCubie.fromFacelet(newFacelet) === -1) {
                return; // not a legal cube state (wrong key or corrupt frame): keep the previous state
            }

            this.bus.emit({
                timestamp,
                type: "FACELETS",
                facelets: newFacelet
            });

            this.bus.emitBattery(msg[35]!, timestamp);
            this.lastTs = ts;
            return;
        }

        if (opcode === OP_STATE_CHANGE) {
            const needsAck = msg.length > 91 && msg[91] !== 0;
            if (needsAck) {
                this.sendMessage(msg.slice(2, 7)).catch(() => {});
            }

            const candidates = collectQiYiStateChangeMoves(msg, ts);
            const newMoves = candidates.filter(
                ([code, moveTs]) => code >= 1 && code <= 12 && moveTs > this.lastTs,
            );

            for (let k = 0; k < newMoves.length; k++) {
                const [code, moveTs] = newMoves[k]!;
                const axis = [4, 1, 3, 0, 2, 5][(code - 1) >> 1]!;
                const power = [0, 2][code & 1]!;
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
                    localTimestamp: k === newMoves.length - 1 ? timestamp : null,
                    cubeTimestamp: Math.trunc(moveTs / QIYI_TICKS_PER_MS)
                });

                this.bus.emit({
                    timestamp,
                    type: "FACELETS",
                    facelets: facelet
                });

                const tmp = this.curCubie;
                this.curCubie = this.prevCubie;
                this.prevCubie = tmp;
            }

            if (newMoves.length > 0) {
                this.lastTs = newMoves[newMoves.length - 1]![1];
            }

            this.bus.emitBattery(msg[35]!, timestamp);
            return;
        }

        if (opcode === OP_SYNC_CONFIRM) {
            // Sync confirmation: emit solved state; no ACK for op 4 in reference protocol.
            if (msg[1] !== 38) return;
            this.bus.emit({
                timestamp,
                type: "FACELETS",
                facelets: QIYI_SOLVED_FACELETS
            });
            this.prevCubie.fromFacelet(QIYI_SOLVED_FACELETS);
            this.lastTs = ts;
            return;
        }

        // Unknown opcode: do not advance lastTs (avoids skewing move history filters).
    }

    private onDisconnect = (): void => {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.bus.resetBatteryDedupe();
        this.bus.emit({ timestamp: now(), type: "DISCONNECT" });
        this.bus.complete();
    };

    async init(): Promise<void> {
        this.device.addEventListener('gattserverdisconnected', this.onDisconnect);
        const gatt = await this.device.gatt!.connect();
        const service = await gatt.getPrimaryService(SERVICE_UUID);
        const chrcts = await service.getCharacteristics();
        this.cubeChrct = findCharacteristic(chrcts, CHRCT_UUID_CUBE);

        if (!this.cubeChrct) {
            throw new Error('[QiYi] Cannot find required characteristic');
        }

        this.cubeChrct.addEventListener('characteristicvaluechanged', this.onCubeEvent);
        await this.cubeChrct.startNotifications();
        await this.sendHello();
    }

    async sendCommand(command: SmartCubeCommand): Promise<void> {
        if (command.type === "REQUEST_FACELETS" || command.type === "REQUEST_BATTERY") {
            if (command.type === "REQUEST_BATTERY") {
                this.bus.forceNextBattery();
            }
            await this.sendHello();
        } else if (command.type === "REQUEST_HARDWARE") {
            this.emitHardwareEvent();
        }
    }

    async disconnect(): Promise<void> {
        if (this.cubeChrct) {
            this.cubeChrct.removeEventListener('characteristicvaluechanged', this.onCubeEvent);
            await this.cubeChrct.stopNotifications().catch(() => {});
            this.cubeChrct = null;
        }
        this.bus.resetBatteryDedupe();
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.bus.emit({ timestamp: now(), type: "DISCONNECT" });
        this.bus.complete();
        if (this.device.gatt?.connected) {
            this.device.gatt.disconnect();
        }
    }
}

function parseQiYiMacFromMf(mfData: BluetoothManufacturerData | DataView | null): string | null {
    if (!mfData) {
        return null;
    }
    return extractMacFromManufacturerData(mfData, QIYI_CIC_LIST, true);
}

async function connectQiYiDevice(
    device: BluetoothDevice,
    macProvider?: MacAddressProvider,
    context?: AttachmentContext
): Promise<SmartCubeConnection> {
    throwIfAborted(context?.signal);
    const mac = await resolveCubeMac(device, macProvider, context, {
        parseFromManufacturerData: parseQiYiMacFromMf,
        advertisementTimeoutsMs: [5000, 8000],
        candidatesFromName: buildQiYiMacCandidatesFromName,
        useSingleCandidateWithoutProbe: true,
        probe: probeQiYiMac,
        probeTimeoutMs: 3000,
    });

    if (!mac) {
        throw new Error('Unable to determine QiYi cube MAC address');
    }

    const conn = new QiYiConnection(device, mac);
    await conn.init();
    return conn;
}

const QIYI_NAME_FILTERS: SmartCubeNameFilter[] = [
    { namePrefix: 'QY-QYSC' },
    { namePrefix: 'XMD-TornadoV4-i' },
];

const qiyiProtocol: SmartCubeProtocol = {
    nameFilters: QIYI_NAME_FILTERS,
    optionalServices: [SERVICE_UUID],
    optionalManufacturerData: QIYI_CIC_LIST,
    needsMac: true,

    matchesDevice: deviceNameMatchesFilters(QIYI_NAME_FILTERS),

    gattAffinity(serviceUuids: ReadonlySet<string>, _device: BluetoothDevice): number {
        return serviceUuids.has(normalizeUuid(SERVICE_UUID)) ? 110 : 0;
    },

    connect: connectQiYiDevice
};

registerProtocol(qiyiProtocol);

export { qiyiProtocol };
