import { Observable, Subject } from 'rxjs';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, SmartCubeProtocolInfo, SmartCubeSnapshot, MacAddressProvider } from '../types';
import { SmartCubeEventBus } from '../event-bus';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { throwIfAborted } from '../attachment/abort';
import { getCachedMacForDevice, macFromGanManufacturerData, waitForManufacturerData } from '../attachment/address-hints';
import { SmartCubeProtocol, SmartCubeNameFilter, deviceNameMatchesFilters, registerProtocol } from '../protocol';
import * as def from '../../gan-cube-definitions';
import { GanGen1CubeConnection } from '../../gan-gen1';
import {
    BluetoothDeviceWithMAC,
    GanCubeConnection,
    GanCubeEvent,
} from '../../gan-cube-protocol';
import { createGanClassicConnection, hasGanGen1Profile } from '../../gan-driver-select';

const DEFAULT_GAN_CAPABILITIES: SmartCubeCapabilities = {
    gyroscope: true,
    battery: true,
    facelets: true,
    hardware: true,
    reset: true,
};

const GAN_GEN1_CAPABILITIES: SmartCubeCapabilities = {
    gyroscope: true,
    battery: true,
    facelets: true,
    hardware: false,
    reset: false,
};

const GAN_GEN1_PROTOCOL: SmartCubeProtocolInfo = { id: 'gan-gen1', name: 'GAN Gen1' };
const GAN_GEN2_PROTOCOL: SmartCubeProtocolInfo = { id: 'gan-gen2', name: 'GAN Gen2' };
const GAN_GEN3_PROTOCOL: SmartCubeProtocolInfo = { id: 'gan-gen3', name: 'GAN Gen3' };
const GAN_GEN4_PROTOCOL: SmartCubeProtocolInfo = { id: 'gan-gen4', name: 'GAN Gen4' };

function ganEventToSmartEvent(event: GanCubeEvent): SmartCubeEvent {
    switch (event.type) {
        case "MOVE":
            return {
                timestamp: event.timestamp,
                type: "MOVE",
                face: event.face,
                direction: event.direction,
                move: event.move,
                localTimestamp: event.localTimestamp,
                cubeTimestamp: event.cubeTimestamp,
                serial: event.serial
            };
        case "FACELETS":
            return {
                timestamp: event.timestamp,
                type: "FACELETS",
                facelets: event.facelets,
                serial: event.serial
            };
        case "GYRO":
            return {
                timestamp: event.timestamp,
                type: "GYRO",
                quaternion: event.quaternion,
                velocity: event.velocity
            };
        case "BATTERY":
            return {
                timestamp: event.timestamp,
                type: "BATTERY",
                batteryLevel: event.batteryLevel
            };
        case "HARDWARE":
            return {
                timestamp: event.timestamp,
                type: "HARDWARE",
                hardwareName: event.hardwareName,
                softwareVersion: event.softwareVersion,
                hardwareVersion: event.hardwareVersion,
                productDate: event.productDate,
                gyroSupported: event.gyroSupported
            };
        case "DISCONNECT":
            return {
                timestamp: event.timestamp,
                type: "DISCONNECT"
            };
    }
}

/**
 * Run a legacy create() with an events subject we own, buffering everything it emits before
 * the SmartCube wrapper exists, so the initial FACELETS/BATTERY reach the state snapshot.
 */
async function createWithCapturedInit<T>(
    create: (events$: Subject<GanCubeEvent>) => Promise<T>
): Promise<{ result: T; captured: GanCubeEvent[] }> {
    const events$ = new Subject<GanCubeEvent>();
    const captured: GanCubeEvent[] = [];
    const sub = events$.subscribe((e) => captured.push(e));
    try {
        const result = await create(events$);
        return { result, captured };
    } finally {
        sub.unsubscribe();
    }
}

class GanSmartCubeConnection implements SmartCubeConnection {
    private ganConn: GanCubeConnection;
    private deviceMac: string;
    private readonly bus: SmartCubeEventBus;
    readonly events$: Observable<SmartCubeEvent>;
    readonly state$: Observable<SmartCubeSnapshot>;

    readonly protocol: SmartCubeProtocolInfo;

    constructor(ganConn: GanCubeConnection, mac: string, protocol: SmartCubeProtocolInfo, capabilities?: SmartCubeCapabilities) {
        this.ganConn = ganConn;
        this.deviceMac = mac;
        this.protocol = protocol;
        const base = capabilities ? { ...capabilities } : { ...DEFAULT_GAN_CAPABILITIES };
        if (!capabilities && ganConn.deviceName?.startsWith('AiCube')) {
            base.gyroscope = false;
        }
        this.bus = new SmartCubeEventBus(base);
        this.events$ = this.bus.events$;
        this.state$ = this.bus.state$;
        ganConn.events$.subscribe({
            next: this.forwardLegacyEvent,
            complete: () => this.bus.complete(),
        });
    }

    private readonly forwardLegacyEvent = (event: GanCubeEvent): void => {
        if (
            event.type === 'HARDWARE' &&
            this.protocol.id === 'gan-gen2' &&
            typeof event.gyroSupported === 'boolean' &&
            this.capabilities.gyroscope !== event.gyroSupported
        ) {
            this.bus.setCapabilities({ gyroscope: event.gyroSupported });
        }
        if (event.type === 'BATTERY') {
            this.bus.emitBattery(event.batteryLevel, event.timestamp);
            return;
        }
        this.bus.emit(ganEventToSmartEvent(event));
    };

    /** Events the legacy connection emitted during init, before this wrapper could subscribe. */
    replayCapturedEvents(events: GanCubeEvent[]): void {
        for (const event of events) {
            this.forwardLegacyEvent(event);
        }
    }

    get capabilities(): SmartCubeCapabilities {
        return this.bus.capabilities as SmartCubeCapabilities;
    }

    getSnapshot(): SmartCubeSnapshot {
        return this.bus.getSnapshot();
    }

    get deviceName(): string {
        return this.ganConn.deviceName;
    }

    get deviceMAC(): string {
        return this.deviceMac;
    }

    async sendCommand(command: SmartCubeCommand): Promise<void> {
        if (command.type === 'REQUEST_BATTERY') {
            this.bus.forceNextBattery();
        }
        return this.ganConn.sendCubeCommand(command);
    }

    async disconnect(): Promise<void> {
        this.bus.resetBatteryDedupe();
        return this.ganConn.disconnect();
    }
}

async function connectGanDevice(
    device: BluetoothDevice,
    macProvider?: MacAddressProvider,
    context?: AttachmentContext
): Promise<SmartCubeConnection> {
    throwIfAborted(context?.signal);
    const bleDevice = device as BluetoothDeviceWithMAC;
    const gatt = device.gatt!;
    if (!gatt.connected) {
        await gatt.connect();
    }
    const services = await gatt.getPrimaryServices();
    const serviceUuidSet = new Set(services.map((s) => normalizeUuid(s.uuid)));

    if (hasGanGen1Profile(serviceUuidSet)) {
        const { result: gen1Conn, captured } = await createWithCapturedInit((events$) =>
            GanGen1CubeConnection.create(device, events$)
        );
        const wrapped = new GanSmartCubeConnection(gen1Conn, '', GAN_GEN1_PROTOCOL, GAN_GEN1_CAPABILITIES);
        wrapped.replayCapturedEvents(captured);
        return wrapped;
    }

    let mac: string | null = null;
    if (context?.advertisementManufacturerData) {
        mac = macFromGanManufacturerData(context.advertisementManufacturerData);
    }
    mac = mac || getCachedMacForDevice(device);
    if (!mac && macProvider) {
        const r = await macProvider(device, false);
        if (r) {
            mac = r;
        }
    }
    if (!mac) {
        const mf = await waitForManufacturerData(device, 5000);
        if (mf) {
            mac = macFromGanManufacturerData(mf);
        }
    }
    if (!mac && macProvider) {
        const r = await macProvider(device, true);
        if (r) {
            mac = r;
        }
    }

    throwIfAborted(context?.signal);
    if (!mac) {
        throw new Error('Unable to determine cube MAC address, connection is not possible!');
    }
    bleDevice.mac = mac;

    const { result: created, captured } = await createWithCapturedInit((events$) =>
        createGanClassicConnection(bleDevice, gatt, serviceUuidSet, mac, { events$ })
    );
    if (!created) {
        throw new Error("Can't find target BLE services - wrong or unsupported cube device model");
    }

    const wrapped = new GanSmartCubeConnection(
        created.conn,
        mac,
        created.generation === 'gen2'
            ? GAN_GEN2_PROTOCOL
            : created.generation === 'gen3'
              ? GAN_GEN3_PROTOCOL
              : GAN_GEN4_PROTOCOL,
    );
    wrapped.replayCapturedEvents(captured);
    return wrapped;
}

const GAN_NAME_FILTERS: SmartCubeNameFilter[] = [{ namePrefix: 'GAN' }, { namePrefix: 'MG' }, { namePrefix: 'AiCube' }];

const ganProtocol: SmartCubeProtocol = {
    nameFilters: GAN_NAME_FILTERS,
    optionalServices: [
        def.GAN_GEN1_PRIMARY_SERVICE,
        def.GAN_GEN1_DEVICE_INFO_SERVICE,
        def.GAN_GEN2_SERVICE,
        def.GAN_GEN3_SERVICE,
        def.GAN_GEN4_SERVICE,
    ],
    optionalManufacturerData: [...def.GAN_CIC_LIST],
    needsMac: true,

    matchesDevice: deviceNameMatchesFilters(GAN_NAME_FILTERS),

    gattAffinity(serviceUuids: ReadonlySet<string>, device: BluetoothDevice): number {
        const g2 = normalizeUuid(def.GAN_GEN2_SERVICE);
        const g3 = normalizeUuid(def.GAN_GEN3_SERVICE);
        const g4 = normalizeUuid(def.GAN_GEN4_SERVICE);
        const g1Primary = normalizeUuid(def.GAN_GEN1_PRIMARY_SERVICE);
        const deviceInfo = normalizeUuid(def.GAN_GEN1_DEVICE_INFO_SERVICE);
        const bonus = serviceUuids.has(deviceInfo) ? 5 : 0;
        // fff0 + Device Information is not GAN-specific (QiYi/XMD expose fff0, many devices
        // expose DIS); claim the gen1 profile only for GAN-style names so those cubes are not
        // routed into the gen1 key-derivation path. Other GAN generations still score below.
        if (serviceUuids.has(g1Primary) && serviceUuids.has(deviceInfo) && ganProtocol.matchesDevice(device)) {
            return 125 + bonus;
        }
        if (serviceUuids.has(g4)) {
            return 120 + bonus;
        }
        if (serviceUuids.has(g3)) {
            return 120 + bonus;
        }
        if (serviceUuids.has(g2)) {
            return 120 + bonus;
        }
        return 0;
    },

    connect: connectGanDevice
};

registerProtocol(ganProtocol);

export { ganProtocol };
