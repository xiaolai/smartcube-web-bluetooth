import * as def from './gan-cube-definitions';
import { GanGen2CubeEncrypter, GanGen3CubeEncrypter, GanGen4CubeEncrypter } from './gan-cube-encrypter';
import { macStringToSaltOrThrow } from './gan-mac-salt';
import {
    isValidGanGen2Packet,
    isValidGanGen3Packet,
    isValidGanGen4Packet,
} from './gan-gen234-packet-validate';
import { normalizeUuid } from './smartcube/attachment/normalize-uuid';
import {
    BluetoothDeviceWithMAC,
    GanCubeConnection,
    GanCubeClassicConnection,
    GanGen2ProtocolDriver,
    GanGen3ProtocolDriver,
    GanGen4ProtocolDriver,
    GanProtocolDriver,
} from './gan-cube-protocol';

export type GanGeneration = 'gen2' | 'gen3' | 'gen4';

export function hasGanGen1Profile(serviceUuids: ReadonlySet<string>): boolean {
    const primary = normalizeUuid(def.GAN_GEN1_PRIMARY_SERVICE);
    const deviceInfo = normalizeUuid(def.GAN_GEN1_DEVICE_INFO_SERVICE);
    return serviceUuids.has(primary) && serviceUuids.has(deviceInfo);
}

type GanGenerationSetup = {
    generation: GanGeneration;
    service: string;
    command: string;
    state: string;
    key: () => { key: number[]; iv: number[] };
    Encrypter: typeof GanGen2CubeEncrypter;
    createDriver: () => GanProtocolDriver;
    validate: (plaintext: Uint8Array) => boolean;
};

/**
 * Pick the GAN generation from the primary services, wire up encrypter, driver and packet
 * validator, and create the classic connection. Returns null when no gen2/3/4 service is
 * present. Shared by the legacy connectGanCube and the SmartCube gan protocol so the two
 * paths cannot drift.
 */
export async function createGanClassicConnection(
    device: BluetoothDeviceWithMAC,
    gatt: BluetoothRemoteGATTServer,
    serviceUuids: ReadonlySet<string>,
    mac: string
): Promise<{ conn: GanCubeConnection; generation: GanGeneration } | null> {
    // MAC bytes in reverse order salt the per-generation AES key/iv.
    const salt = macStringToSaltOrThrow(mac);

    const setups: GanGenerationSetup[] = [
        {
            generation: 'gen2',
            service: def.GAN_GEN2_SERVICE,
            command: def.GAN_GEN2_COMMAND_CHARACTERISTIC,
            state: def.GAN_GEN2_STATE_CHARACTERISTIC,
            /** MoYu AI 2023 speaks the GAN gen2 protocol with its own key. */
            key: () => (device.name?.startsWith('AiCube') ? def.GAN_ENCRYPTION_KEYS[1] : def.GAN_ENCRYPTION_KEYS[0]),
            Encrypter: GanGen2CubeEncrypter,
            createDriver: () => new GanGen2ProtocolDriver(),
            validate: isValidGanGen2Packet,
        },
        {
            generation: 'gen3',
            service: def.GAN_GEN3_SERVICE,
            command: def.GAN_GEN3_COMMAND_CHARACTERISTIC,
            state: def.GAN_GEN3_STATE_CHARACTERISTIC,
            key: () => def.GAN_ENCRYPTION_KEYS[0],
            Encrypter: GanGen3CubeEncrypter,
            createDriver: () => new GanGen3ProtocolDriver(),
            validate: isValidGanGen3Packet,
        },
        {
            generation: 'gen4',
            service: def.GAN_GEN4_SERVICE,
            command: def.GAN_GEN4_COMMAND_CHARACTERISTIC,
            state: def.GAN_GEN4_STATE_CHARACTERISTIC,
            key: () => def.GAN_ENCRYPTION_KEYS[0],
            Encrypter: GanGen4CubeEncrypter,
            createDriver: () => new GanGen4ProtocolDriver(),
            validate: isValidGanGen4Packet,
        },
    ];

    for (const setup of setups) {
        if (!serviceUuids.has(normalizeUuid(setup.service))) {
            continue;
        }
        const service = await gatt.getPrimaryService(setup.service);
        const commandCharacteristic = await service.getCharacteristic(setup.command);
        const stateCharacteristic = await service.getCharacteristic(setup.state);
        const key = setup.key();
        const encrypter = new setup.Encrypter(new Uint8Array(key.key), new Uint8Array(key.iv), salt);
        const conn = await GanCubeClassicConnection.create(
            device,
            commandCharacteristic,
            stateCharacteristic,
            encrypter,
            setup.createDriver(),
            { validateDecrypted: setup.validate }
        );
        return { conn, generation: setup.generation };
    }
    return null;
}
