
import * as def from './gan-cube-definitions';
import { GanGen1CubeConnection } from './gan-gen1';
import { normalizeUuid } from './smartcube/attachment/normalize-uuid';
import { macFromGanManufacturerData, waitForManufacturerData } from './smartcube/attachment/address-hints';
import type { MacAddressProvider } from './smartcube/types';
import {
    BluetoothDeviceWithMAC,
    GanCubeConnection,
    GanCubeCommand,
    GanCubeEvent,
    GanCubeMove,
} from './gan-cube-protocol';
import { createGanClassicConnection, hasGanGen1Profile } from './gan-driver-select';

/**
 * Initiate new connection with the GAN Smart Cube device.
 *
 * Note: unlike `connectSmartCube`, this legacy API does not verify the resolved MAC
 * against decrypted traffic before returning — that behaviour is part of its
 * long-standing contract.
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
    const optionalServices = [
        ...new Set([
            def.GAN_GEN1_PRIMARY_SERVICE,
            def.GAN_GEN1_DEVICE_INFO_SERVICE,
            def.GAN_GEN2_SERVICE,
            def.GAN_GEN3_SERVICE,
            def.GAN_GEN4_SERVICE,
        ]),
    ];
    const device: BluetoothDeviceWithMAC = await navigator.bluetooth.requestDevice(
        {
            filters: [...nameFilters, ...cicFilters],
            optionalServices,
            // Without this grant, watchAdvertisements() may not expose the manufacturer
            // bytes the automatic MAC discovery needs.
            optionalManufacturerData: [...def.GAN_CIC_LIST],
        }
    );

    // Resolve the MAC hints BEFORE connecting: connectable peripherals commonly stop
    // advertising once a GATT connection exists, so a post-connect advertisement wait
    // would mostly just time out.
    let mac: string | null = null;
    if (customMacAddressProvider) {
        mac = await customMacAddressProvider(device, false);
    }
    if (!mac) {
        const mfData = await waitForManufacturerData(device, 5000);
        mac = mfData ? macFromGanManufacturerData(mfData) : null;
    }

    if (!device.gatt) {
        throw new Error('This device does not support GATT connections');
    }
    const gatt = await device.gatt.connect();
    try {
        const services = await gatt.getPrimaryServices();
        const serviceUuidSet = new Set(services.map((s) => normalizeUuid(s.uuid)));

        if (hasGanGen1Profile(serviceUuidSet)) {
            return await GanGen1CubeConnection.create(device);
        }

        if (!mac && customMacAddressProvider) {
            mac = await customMacAddressProvider(device, true);
        }
        if (!mac) {
            throw new Error('Unable to determine cube MAC address, connection is not possible!');
        }
        // Kept for backwards compatibility: existing consumers may read device.mac.
        device.mac = mac;

        const created = await createGanClassicConnection(device, gatt, serviceUuidSet, mac);
        if (!created) {
            throw new Error("Can't find target BLE services - wrong or unsupported cube device model");
        }

        return created.conn;
    } catch (e) {
        // Any failure after the GATT connection exists must not leave the device connected.
        try {
            gatt.disconnect();
        } catch {
            /* ignore */
        }
        throw e;
    }

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
