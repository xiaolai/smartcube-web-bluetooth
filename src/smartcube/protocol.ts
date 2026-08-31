
import type { AttachmentContext } from './attachment/types';
import { SmartCubeConnection, MacAddressProvider } from './types';

/** Single OR branch for `requestDevice` (`namePrefix`, exact `name`, or both via multiple entries). */
export type SmartCubeNameFilter =
    | { namePrefix: string; name?: never }
    | { name: string; namePrefix?: never };

interface SmartCubeProtocol {
    nameFilters: SmartCubeNameFilter[];
    optionalServices: string[];
    optionalManufacturerData?: number[];
    /**
     * True when the driver must learn the cube's Bluetooth address (key derivation) before it can
     * talk to the cube. `connectSmartCube()` skips the pre-connect advertisement wait when every
     * protocol whose name filter matches the selected device leaves this unset.
     */
    needsMac?: boolean;
    matchesDevice(device: BluetoothDevice): boolean;
    /**
     * Higher scores win when choosing a driver from primary service UUIDs.
     * Use 0 when this profile does not match the GATT snapshot.
     */
    gattAffinity(serviceUuids: ReadonlySet<string>, device: BluetoothDevice): number;
    connect(
        device: BluetoothDevice,
        macProvider?: MacAddressProvider,
        context?: AttachmentContext
    ): Promise<SmartCubeConnection>;
}

const protocolRegistry: SmartCubeProtocol[] = [];

function registerProtocol(protocol: SmartCubeProtocol): void {
    if (!protocolRegistry.includes(protocol)) {
        // Freeze the descriptor so its filters/services cannot change under an
        // in-flight connection attempt (selection and the picker options are built
        // from these across awaits).
        Object.freeze(protocol.nameFilters);
        Object.freeze(protocol.optionalServices);
        if (protocol.optionalManufacturerData) {
            Object.freeze(protocol.optionalManufacturerData);
        }
        protocolRegistry.push(Object.freeze(protocol));
    }
}

/** Returns a snapshot: mutating the result cannot affect protocol selection. */
function getRegisteredProtocols(): SmartCubeProtocol[] {
    return [...protocolRegistry];
}

/** Remove a previously registered protocol (tests, dynamically loaded drivers). */
function unregisterProtocol(protocol: SmartCubeProtocol): void {
    const i = protocolRegistry.indexOf(protocol);
    if (i >= 0) {
        protocolRegistry.splice(i, 1);
    }
}

/** Standard matchesDevice: the advertised name satisfies one of the protocol's name filters. */
function deviceNameMatchesFilters(nameFilters: SmartCubeNameFilter[]): (device: BluetoothDevice) => boolean {
    const filters = [...nameFilters];
    return (device) => {
        const name = device.name;
        if (!name) {
            return false; // an unnamed device matches nothing, not everything
        }
        return filters.some((f) =>
            typeof f.name === 'string' ? name === f.name : f.namePrefix !== '' && name.startsWith(f.namePrefix),
        );
    };
}

export type { SmartCubeProtocol };
export { registerProtocol, getRegisteredProtocols, unregisterProtocol, deviceNameMatchesFilters };
export type { AttachmentContext, ConnectSmartCubeOptions, DeviceSelectionMode } from './attachment/types';
