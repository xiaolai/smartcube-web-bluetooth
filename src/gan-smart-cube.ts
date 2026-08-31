
import * as def from './gan-cube-definitions';
import { GanGen1CubeConnection } from './gan-gen1';
import { normalizeUuid } from './smartcube/attachment/normalize-uuid';
import { macFromGanManufacturerData, waitForManufacturerData } from './smartcube/attachment/address-hints';
import {
    BluetoothDeviceWithMAC,
    GanCubeConnection,
    GanCubeCommand,
    GanCubeEvent,
    GanCubeMove,
} from './gan-cube-protocol';
import { createGanClassicConnection, hasGanGen1Profile } from './gan-driver-select';

/** If the browser supports watchAdvertisements(), read the MAC from advertisement manufacturer data. */
async function autoRetrieveMacAddress(device: BluetoothDevice): Promise<string | null> {
    const mf = await waitForManufacturerData(device, 5000);
    return mf ? macFromGanManufacturerData(mf) : null;
}

/**
 * Type representing function interface to implement custom MAC address provider
 * @param device Current BluetoothDevice selected by user.
 * @param isFallbackCall Flag indicating this is final and last resort call for MAC address.
 *                       If this flag is not set, custom provider can return null instead of MAC,
 *                       in such case library will try to read MAC automatically.
 */
type MacAddressProvider = (device: BluetoothDevice, isFallbackCall?: boolean) => Promise<string | null>;

/**
 * Initiate new connection with the GAN Smart Cube device
 * @param customMacAddressProvider Optional custom provider for cube MAC address
 * @returns Object representing connection API and state
 */
async function connectGanCube(customMacAddressProvider?: MacAddressProvider): Promise<GanCubeConnection> {

    // Request user for the bluetooth device (popup selection dialog)
    const nameFilters: BluetoothLEScanFilter[] = [
        { namePrefix: "GAN" },
        { namePrefix: "MG" },
        { namePrefix: "AiCube" },
    ];
    const cicFilters: BluetoothLEScanFilter[] = def.GAN_CIC_LIST.map((companyIdentifier) => ({
        manufacturerData: [{ companyIdentifier }],
    }));
    var device: BluetoothDeviceWithMAC = await navigator.bluetooth.requestDevice(
        {
            filters: [...nameFilters, ...cicFilters],
            optionalServices: [
                def.GAN_GEN1_PRIMARY_SERVICE,
                def.GAN_GEN1_DEVICE_INFO_SERVICE,
                def.GAN_GEN2_SERVICE,
                def.GAN_GEN3_SERVICE,
                def.GAN_GEN4_SERVICE,
                "0000180a-0000-1000-8000-00805f9b34fb",
                "00001800-0000-1000-8000-00805f9b34fb",
            ],
        }
    );

    // Connect to GATT and get primary services
    var gatt = await device.gatt!.connect();
    var services = await gatt.getPrimaryServices();
    const serviceUuidSet = new Set(services.map((s) => normalizeUuid(s.uuid)));

    if (hasGanGen1Profile(serviceUuidSet)) {
        return GanGen1CubeConnection.create(device);
    }

    // Retrieve cube MAC address needed for key salting
    var mac = customMacAddressProvider && await customMacAddressProvider(device, false)
        || await autoRetrieveMacAddress(device)
        || customMacAddressProvider && await customMacAddressProvider(device, true);

    if (!mac)
        throw new Error('Unable to determine cube MAC address, connection is not possible!');
    device.mac = mac;

    const created = await createGanClassicConnection(device, gatt, serviceUuidSet, mac);
    if (!created)
        throw new Error("Can't find target BLE services - wrong or unsupported cube device model");

    return created.conn;

}

export type {
    MacAddressProvider,
    GanCubeConnection,
    GanCubeCommand,
    GanCubeEvent,
    GanCubeMove
};

export {
    connectGanCube
};
