
import { SmartCubeConnection, SmartCubeCommand, SmartCubeCapabilities, SmartCubeProtocolInfo, MacAddressProvider } from '../types';
import { GattSmartCubeConnection } from '../gatt-connection';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { SmartCubeProtocol, SmartCubeNameFilter, deviceNameMatchesFilters, registerProtocol } from '../protocol';
import { CubieCube, moveDirectionFromNotation } from '../cubie-cube';
import { findCharacteristic } from '../ble-utils';
import { now } from '../../utils';
import { writeGattCharacteristicValue } from '../../gatt-characteristic-write';
import {
    GIIKER_CONTROL_READ_CHARACTERISTIC,
    GIIKER_CONTROL_SERVICE,
    GIIKER_CONTROL_WRITE_CHARACTERISTIC,
    GIIKER_DATA_CHARACTERISTIC,
    GIIKER_DATA_SERVICE,
} from '../gatt-uuids';

// SUPERSEDED: UUIDs come from smartcube/gatt-uuids.ts, the single source for every brand.
// const UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';
// const SERVICE_UUID_DATA = '0000aadb' + UUID_SUFFIX;
// const CHRCT_UUID_DATA = '0000aadc' + UUID_SUFFIX;
// const SERVICE_UUID_RW = '0000aaaa' + UUID_SUFFIX;
// const CHRCT_UUID_READ = '0000aaab' + UUID_SUFFIX;
// const CHRCT_UUID_WRITE = '0000aaac' + UUID_SUFFIX;

/** Every Giiker state notification/read is a 20-byte frame (18 data bytes + encryption marker/key nibbles). */
const GIIKER_STATE_LENGTH = 20;
/** Control-service opcodes (0xAAAC write / 0xAAAB response). */
const GIIKER_OP_BATTERY = 0xb5;
const GIIKER_OP_RESET = 0xa1;

const GIIKER_CFACELET = [
    [26, 15, 29], [20, 8, 9], [18, 38, 6], [24, 27, 44],
    [51, 35, 17], [45, 11, 2], [47, 0, 36], [53, 42, 33]
];

const GIIKER_EFACELET = [
    [25, 28], [23, 12], [19, 7], [21, 41],
    [32, 16], [5, 10], [3, 37], [30, 43],
    [52, 34], [48, 14], [46, 1], [50, 39]
];

const DECRYPT_KEY = [176, 81, 104, 224, 86, 137, 237, 119, 38, 26, 193, 161, 210, 126, 150, 81, 93, 13, 236, 249, 89, 235, 88, 24, 113, 81, 214, 131, 130, 199, 2, 169, 39, 165, 171, 41];
const CO_MASK = [-1, 1, -1, 1, 1, -1, 1, -1];

function giikerHexPayload(value: DataView): number[] {
    const raw: number[] = [];
    for (let i = 0; i < 20; i++) {
        raw.push(value.getUint8(i));
    }

    let logicalBytes = raw.length;
    if (raw[18] === 0xa7) {
        const k1 = (raw[19] >> 4) & 0xf;
        const k2 = raw[19] & 0xf;
        for (let i = 0; i < 18; i++) {
            raw[i] = (raw[i] + DECRYPT_KEY[i + k1] + DECRYPT_KEY[i + k2]) & 0xFF;
        }
        logicalBytes = 18;
    }

    const valhex: number[] = [];
    for (let i = 0; i < logicalBytes; i++) {
        valhex.push((raw[i] >> 4) & 0xf);
        valhex.push(raw[i] & 0xf);
    }
    return valhex;
}

function giikerMoveString(faceNibble: number, dirNibble: number): string | null {
    const face = ["?", "B", "D", "L", "U", "R", "F"][faceNibble];
    if (!face || face === "?") return null;

    // Verified against the captured session: 1 = clockwise, 3 = prime. 2 and the
    // 9 some firmwares send are half turns. Unknown values are rejected, not
    // silently treated as clockwise.
    const suffix = ({ 1: '', 2: '2', 3: "'", 9: '2' } as Record<number, string>)[dirNibble];
    if (suffix === undefined) return null;
    return `${face}${suffix}`;
}

/** Decode a state frame; returns null when the payload is not a structurally valid cube. */
function parseState(value: DataView): { facelet: string; prevMoves: string[] } | null {
    const valhex = giikerHexPayload(value);

    // Validate nibble ranges before indexing facelet tables: corrupt frames
    // previously threw inside toFaceCube or emitted impossible states.
    for (let i = 0; i < 8; i++) {
        if (valhex[i]! < 1 || valhex[i]! > 8) return null;
    }
    for (let i = 0; i < 12; i++) {
        if (valhex[i + 16]! < 1 || valhex[i + 16]! > 12) return null;
    }

    const eo: number[] = [];
    for (let i = 0; i < 3; i++) {
        for (let mask = 8; mask !== 0; mask >>= 1) {
            eo.push((valhex[i + 28] & mask) ? 1 : 0);
        }
    }

    const cc = new CubieCube();
    const cornersSeen = new Set<number>();
    const edgesSeen = new Set<number>();
    for (let i = 0; i < 8; i++) {
        cc.ca[i] = (valhex[i] - 1) | (((3 + valhex[i + 8] * CO_MASK[i]) % 3) << 3);
        cornersSeen.add(valhex[i]!);
    }
    for (let i = 0; i < 12; i++) {
        cc.ea[i] = ((valhex[i + 16] - 1) << 1) | eo[i];
        edgesSeen.add(valhex[i + 16]!);
    }
    if (cornersSeen.size !== 8 || edgesSeen.size !== 12) {
        return null; // duplicate pieces: not a cube state
    }
    const facelet = cc.toFaceCube(GIIKER_CFACELET, GIIKER_EFACELET);

    const prevMoves: string[] = [];
    // Byte 16 is the current move (face/dir nibbles). Encrypted packets must ignore bytes 18–19.
    const faceNibble = valhex[32];
    const dirNibble = valhex[33];
    if (faceNibble !== undefined && dirNibble !== undefined) {
        const mv = giikerMoveString(faceNibble, dirNibble);
        if (mv) prevMoves.push(mv);
    }

    return { facelet, prevMoves };
}

const GIIKER_PROTOCOL: SmartCubeProtocolInfo = { id: 'giiker', name: 'Giiker' };

const GIIKER_CAPABILITIES: SmartCubeCapabilities = {
    gyroscope: false,
    // battery and reset are enabled only once the optional control service is up.
    battery: false,
    facelets: true,
    hardware: true,
    reset: false
};

class GiikerConnection extends GattSmartCubeConnection {
    private gatt: BluetoothRemoteGATTServer | null = null;
    private dataChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private lastFacelet: string = '';
    /** MOVE events are suppressed until init completes: pre-connect frames only seed state. */
    private live = false;
    private closed = false;
    private rwReadChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private rwWriteChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private onBatteryChanged: ((evt: Event) => void) | null = null;
    private batteryPollFailures = 0;

    constructor(device: BluetoothDevice, name: string) {
        super(device, GIIKER_PROTOCOL, name, '', GIIKER_CAPABILITIES);
    }

    // SUPERSEDED: the bus facade, device and lifecycle live in GattSmartCubeConnection.
    // readonly deviceName: string;
    // readonly deviceMAC: string;
    // readonly protocol: SmartCubeProtocolInfo = GIIKER_PROTOCOL;
    // private readonly bus = new SmartCubeEventBus({ ...GIIKER_CAPABILITIES });
    // readonly events$: Observable<SmartCubeEvent> = this.bus.events$;
    // readonly state$: Observable<SmartCubeSnapshot> = this.bus.state$;
    // private device: BluetoothDevice;
    // private batteryInterval: ReturnType<typeof setInterval> | null = null;
    // constructor(device: BluetoothDevice, name: string) {
    //     this.device = device;
    //     this.deviceName = name;
    //     this.deviceMAC = '';
    // }
    // get capabilities(): SmartCubeCapabilities {
    //     return this.bus.capabilities as SmartCubeCapabilities;
    // }
    // getSnapshot(): SmartCubeSnapshot {
    //     return this.bus.getSnapshot();
    // }

    private onStateChanged = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value || value.byteLength < GIIKER_STATE_LENGTH) return; // truncated frame
        // Frames are processed in arrival order from the moment notifications start —
        // queueing them for replay after the initial read could reverse state order.
        this.handleStateValue(value, now());
    };

    /** Decode one state frame and emit the derived MOVE (if any) plus FACELETS. */
    private handleStateValue(value: DataView, timestamp: number): void {
        const parsed = parseState(value);
        if (!parsed) {
            return; // corrupt frame: keep the previous state
        }
        const { facelet, prevMoves } = parsed;

        if (this.live && this.lastFacelet && this.lastFacelet !== facelet && prevMoves.length > 0) {
            const moveStr = prevMoves[0].trim();
            const face = "URFDLB".indexOf(moveStr[0]);
            const direction = moveDirectionFromNotation(moveStr);

            this.bus.emit({
                timestamp,
                type: "MOVE",
                face,
                direction,
                move: moveStr,
                localTimestamp: timestamp,
                cubeTimestamp: null
            });
        }

        this.lastFacelet = facelet;
        this.bus.emit({
            timestamp,
            type: "FACELETS",
            facelets: facelet
        });
    }

    // SUPERSEDED: GattSmartCubeConnection.emitHardwareEventFromName(). Giiker never enables the gyroscope capability, so `this.capabilities.gyroscope` is the same `false`.
    // private emitHardwareEvent(): void {
    //     this.bus.emit({
    //         timestamp: now(),
    //         type: "HARDWARE",
    //         hardwareName: this.deviceName,
    //         gyroSupported: false
    //     });
    // }
    protected override releaseResources(): void {
        this.closed = true;
        this.live = false;
        if (this.dataChrct) {
            this.dataChrct.removeEventListener('characteristicvaluechanged', this.onStateChanged);
            this.dataChrct = null;
        }
        if (this.rwReadChrct && this.onBatteryChanged) {
            this.rwReadChrct.removeEventListener('characteristicvaluechanged', this.onBatteryChanged);
        }
        this.rwReadChrct = null;
        this.onBatteryChanged = null;
        this.rwWriteChrct = null;
    }

    // SUPERSEDED: GattSmartCubeConnection.teardown() runs releaseResources() at the same point in the same order.
    // /** Idempotent teardown shared by remote and explicit disconnects. */
    // private teardown(): void {
    //     this.closed = true;
    //     this.live = false;
    //     this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
    //     if (this.dataChrct) {
    //         this.dataChrct.removeEventListener('characteristicvaluechanged', this.onStateChanged);
    //         this.dataChrct = null;
    //     }
    //     if (this.rwReadChrct && this.onBatteryChanged) {
    //         this.rwReadChrct.removeEventListener('characteristicvaluechanged', this.onBatteryChanged);
    //     }
    //     this.onBatteryChanged = null;
    //     this.rwWriteChrct = null;
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
    async init(): Promise<void> {
        await this.initialize(async () => {
            this.gatt = await this.device.gatt!.connect();
            const dataService = await this.gatt.getPrimaryService(GIIKER_DATA_SERVICE);
            this.dataChrct = await dataService.getCharacteristic(GIIKER_DATA_CHARACTERISTIC);

            // Attach listener before notifications to reduce missed packets.
            this.dataChrct.addEventListener('characteristicvaluechanged', this.onStateChanged);
            await this.dataChrct.startNotifications();
            const initialValue = await this.dataChrct.readValue();
            if (!this.lastFacelet) {
                // No notification established a baseline yet: use the explicit read.
                if (initialValue.byteLength < GIIKER_STATE_LENGTH) {
                    throw new Error(`[Giiker] Unexpected state length ${initialValue.byteLength}, expected ${GIIKER_STATE_LENGTH}`);
                }
                const parsed = parseState(initialValue);
                if (!parsed) {
                    throw new Error('[Giiker] Initial state read is not a valid cube state');
                }
                this.lastFacelet = parsed.facelet;
                this.bus.emit({
                    timestamp: now(),
                    type: "FACELETS",
                    facelets: parsed.facelet
                });
            }

            await this.setupBatteryService();

            if (this.closed) {
                // The device disconnected while optional setup was in flight.
                throw new Error('[Giiker] disconnected during initialization');
            }
            this.live = true;
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

    /** Optional control service: capabilities are enabled only after setup succeeds. */
    private async setupBatteryService(): Promise<void> {
        try {
            const rwService = await this.gatt!.getPrimaryService(GIIKER_CONTROL_SERVICE);
            const chrcts = await rwService.getCharacteristics();
            const readChrct = findCharacteristic(chrcts, GIIKER_CONTROL_READ_CHARACTERISTIC);
            const writeChrct = findCharacteristic(chrcts, GIIKER_CONTROL_WRITE_CHARACTERISTIC);
            if (!readChrct || !writeChrct) {
                return;
            }
            const onBatteryChanged = (evt: Event): void => {
                const val = (evt.target as BluetoothRemoteGATTCharacteristic).value;
                // Only 0xB5 responses with a payload byte are battery reports.
                if (!val || val.byteLength < 2 || val.getUint8(0) !== GIIKER_OP_BATTERY) return;
                this.bus.emitBattery(val.getUint8(1));
            };
            readChrct.addEventListener('characteristicvaluechanged', onBatteryChanged);
            try {
                await readChrct.startNotifications();
            } catch (e) {
                readChrct.removeEventListener('characteristicvaluechanged', onBatteryChanged);
                throw e;
            }
            // Commit fields only after the whole setup succeeded.
            this.rwReadChrct = readChrct;
            this.rwWriteChrct = writeChrct;
            this.onBatteryChanged = onBatteryChanged;
            this.bus.setCapabilities({ battery: true, reset: true });
            this.batteryPollFailures = 0;
            this.requestBatteryPoll();
            this.startBatteryPolling(() => this.requestBatteryPoll());
        } catch {
            // Control service absent or unusable: battery/reset stay unavailable.
        }
    }

    private requestBatteryPoll(): void {
        if (!this.rwWriteChrct) return;
        writeGattCharacteristicValue(this.rwWriteChrct, new Uint8Array([GIIKER_OP_BATTERY]).buffer).then(
            () => {
                this.batteryPollFailures = 0;
            },
            () => {
                // A permanently broken control channel should not poll forever while
                // advertising a battery capability it cannot serve.
                if (++this.batteryPollFailures >= 5) {
                    this.stopBatteryPolling();
                    this.bus.setCapabilities({ battery: false });
                }
            },
        );
    }

    override async sendCommand(command: SmartCubeCommand): Promise<void> {
        if (command.type === "REQUEST_BATTERY") {
            // Periodic battery polling is set up in init when available.
            if (this.rwWriteChrct) {
                this.bus.forceNextBattery();
                try {
                    await writeGattCharacteristicValue(this.rwWriteChrct, new Uint8Array([GIIKER_OP_BATTERY]).buffer);
                } catch (e) {
                    this.bus.cancelForcedBattery();
                    throw e;
                }
            }
        } else if (command.type === "REQUEST_FACELETS") {
            if (this.lastFacelet) {
                this.bus.emit({
                    timestamp: now(),
                    type: "FACELETS",
                    facelets: this.lastFacelet
                });
            }
        } else if (command.type === "REQUEST_HARDWARE") {
            this.emitHardwareEventFromName();
        } else if (command.type === "REQUEST_RESET") {
            if (this.rwWriteChrct) {
                await writeGattCharacteristicValue(this.rwWriteChrct, new Uint8Array([GIIKER_OP_RESET]).buffer);
            }
        }
    }

    protected override notifyingCharacteristics(): (BluetoothRemoteGATTCharacteristic | null)[] {
        return [this.dataChrct, this.rwReadChrct];
    }

    // SUPERSEDED: GattSmartCubeConnection.disconnect() stops notifyingCharacteristics() and drops the GATT link.
    // async disconnect(): Promise<void> {
    //     const dataChrct = this.dataChrct;
    //     const rwReadChrct = this.rwReadChrct;
    //     this.rwReadChrct = null;
    //     this.teardown();
    //     if (dataChrct) {
    //         await dataChrct.stopNotifications().catch(() => {});
    //     }
    //     if (rwReadChrct) {
    //         await rwReadChrct.stopNotifications().catch(() => {});
    //     }
    //     if (this.device.gatt?.connected) {
    //         this.device.gatt.disconnect();
    //     }
    // }
}

const GIIKER_NAME_FILTERS: SmartCubeNameFilter[] = [
    { namePrefix: 'Gi' },
    { namePrefix: 'Mi Smart Magic Cube' },
    { namePrefix: 'Hi-' },
];

const giikerProtocol: SmartCubeProtocol = {
    nameFilters: GIIKER_NAME_FILTERS,
    optionalServices: [GIIKER_DATA_SERVICE, GIIKER_CONTROL_SERVICE],

    matchesDevice: deviceNameMatchesFilters(GIIKER_NAME_FILTERS),

    gattAffinity(serviceUuids: ReadonlySet<string>, _device: BluetoothDevice): number {
        return serviceUuids.has(normalizeUuid(GIIKER_DATA_SERVICE)) ? 115 : 0;
    },

    async connect(
        device: BluetoothDevice,
        _macProvider?: MacAddressProvider,
        _context?: AttachmentContext
    ): Promise<SmartCubeConnection> {
        const devName = device.name || '';
        // Ordered table: the first matching prefix names the model.
        const MODEL_NAMES: readonly [string, string][] = [
            ['GiC', 'Giiker i3'],
            ['GiS', 'Giiker i3S'],
            ['GiY', 'Giiker i3Y'],
            ['Mi Smart', 'Mi Smart Magic Cube'],
            ['Gi', 'Giiker i3SE'],
            ['Hi-', 'Hi-'],
        ];
        const name = MODEL_NAMES.find(([prefix]) => devName.startsWith(prefix))?.[1] ?? (devName || 'Unknown');
        const conn = new GiikerConnection(device, name);
        await conn.init();
        return conn;
    }
};

registerProtocol(giikerProtocol);

export { giikerProtocol };
