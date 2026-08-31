import { Subject } from 'rxjs';
import { SmartCubeConnection, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, SmartCubeProtocolInfo, MacAddressProvider } from '../types';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { throwIfAborted } from '../attachment/abort';
import { getCachedMacForDevice, macFromGanManufacturerData, waitForManufacturerData } from '../attachment/address-hints';
import { SmartCubeProtocol, registerProtocol } from '../protocol';
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
                cubeTimestamp: event.cubeTimestamp
            };
        case "FACELETS":
            return {
                timestamp: event.timestamp,
                type: "FACELETS",
                facelets: event.facelets
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

class GanSmartCubeConnection implements SmartCubeConnection {
    private ganConn: GanCubeConnection;
    private deviceMac: string;
    private lastBatteryLevel: number | null = null;
    private forceNextBatteryEmission = false;
    events$: Subject<SmartCubeEvent>;

    readonly protocol: SmartCubeProtocolInfo;
    readonly capabilities: SmartCubeCapabilities;

    constructor(ganConn: GanCubeConnection, mac: string, protocol: SmartCubeProtocolInfo, capabilities?: SmartCubeCapabilities) {
        this.ganConn = ganConn;
        this.deviceMac = mac;
        this.protocol = protocol;
        const base = capabilities ? { ...capabilities } : { ...DEFAULT_GAN_CAPABILITIES };
        if (!capabilities && ganConn.deviceName?.startsWith('AiCube')) {
            base.gyroscope = false;
        }
        this.capabilities = base;
        this.events$ = new Subject<SmartCubeEvent>();
        ganConn.events$.subscribe({
            next: (event) => {
                if (
                    event.type === 'HARDWARE' &&
                    this.protocol.id === 'gan-gen2' &&
                    typeof event.gyroSupported === 'boolean'
                ) {
                    this.capabilities.gyroscope = event.gyroSupported;
                }
                if (event.type === 'BATTERY') {
                    const batteryLevel = Math.min(100, Math.max(0, Math.round(event.batteryLevel)));
                    const forceEmission = this.forceNextBatteryEmission;
                    this.forceNextBatteryEmission = false;
                    if (!forceEmission && this.lastBatteryLevel === batteryLevel) {
                        return;
                    }
                    this.lastBatteryLevel = batteryLevel;
                    this.events$.next({
                        timestamp: event.timestamp,
                        type: 'BATTERY',
                        batteryLevel,
                    });
                    return;
                }
                this.events$.next(ganEventToSmartEvent(event));
            },
            complete: () => this.events$.complete(),
        });
    }

    get deviceName(): string {
        return this.ganConn.deviceName;
    }

    get deviceMAC(): string {
        return this.deviceMac;
    }

    async sendCommand(command: SmartCubeCommand): Promise<void> {
        if (command.type === 'REQUEST_BATTERY') {
            this.forceNextBatteryEmission = true;
        }
        return this.ganConn.sendCubeCommand(command);
    }

    async disconnect(): Promise<void> {
        this.forceNextBatteryEmission = false;
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
        const gen1Conn = await GanGen1CubeConnection.create(device);
        return new GanSmartCubeConnection(gen1Conn, '', GAN_GEN1_PROTOCOL, GAN_GEN1_CAPABILITIES);
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

    const created = await createGanClassicConnection(bleDevice, gatt, serviceUuidSet, mac);
    if (!created) {
        throw new Error("Can't find target BLE services - wrong or unsupported cube device model");
    }

    return new GanSmartCubeConnection(
        created.conn,
        mac,
        created.generation === 'gen2'
            ? GAN_GEN2_PROTOCOL
            : created.generation === 'gen3'
              ? GAN_GEN3_PROTOCOL
              : GAN_GEN4_PROTOCOL,
    );
}

const ganProtocol: SmartCubeProtocol = {
    nameFilters: [{ namePrefix: 'GAN' }, { namePrefix: 'MG' }, { namePrefix: 'AiCube' }],
    optionalServices: [
        def.GAN_GEN1_PRIMARY_SERVICE,
        def.GAN_GEN1_DEVICE_INFO_SERVICE,
        def.GAN_GEN2_SERVICE,
        def.GAN_GEN3_SERVICE,
        def.GAN_GEN4_SERVICE,
    ],
    optionalManufacturerData: def.GAN_CIC_LIST,
    needsMac: true,

    matchesDevice(device: BluetoothDevice): boolean {
        const name = device.name || '';
        return name.startsWith('GAN') || name.startsWith('MG') || name.startsWith('AiCube');
    },

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
