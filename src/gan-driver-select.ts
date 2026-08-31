import * as def from './gan-cube-definitions';
import { GanGen2CubeEncrypter, GanGen3CubeEncrypter, GanGen4CubeEncrypter } from './gan-cube-encrypter';
import { macStringToSaltOrThrow } from './gan-mac-salt';
import {
    isValidGanGen2Packet,
    isValidGanGen3Packet,
    isValidGanGen4Packet,
} from './gan-gen234-packet-validate';
import { normalizeUuid } from './smartcube/attachment/normalize-uuid';
import { Subject } from 'rxjs';
import {
    BluetoothDeviceWithMAC,
    GanCubeConnection,
    GanCubeEvent,
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
    key: (device: BluetoothDevice) => { readonly key: readonly number[]; readonly iv: readonly number[] };
    Encrypter: typeof GanGen2CubeEncrypter;
    createDriver: () => GanProtocolDriver;
    validate: (plaintext: Uint8Array) => boolean;
};

/**
 * Tried in declaration order — a device exposing several recognized services (e.g. a
 * compatibility profile) deliberately resolves to the earliest generation listed here.
 */
const GAN_GENERATION_SETUPS: readonly GanGenerationSetup[] = [
    {
        generation: 'gen2',
        service: def.GAN_GEN2_SERVICE,
        command: def.GAN_GEN2_COMMAND_CHARACTERISTIC,
        state: def.GAN_GEN2_STATE_CHARACTERISTIC,
        /** MoYu AI 2023 speaks the GAN gen2 protocol with its own key. */
        key: (device) => (device.name?.startsWith('AiCube') ? def.GAN_ENCRYPTION_KEYS[1]! : def.GAN_ENCRYPTION_KEYS[0]!),
        Encrypter: GanGen2CubeEncrypter,
        createDriver: () => new GanGen2ProtocolDriver(),
        validate: isValidGanGen2Packet,
    },
    {
        generation: 'gen3',
        service: def.GAN_GEN3_SERVICE,
        command: def.GAN_GEN3_COMMAND_CHARACTERISTIC,
        state: def.GAN_GEN3_STATE_CHARACTERISTIC,
        key: () => def.GAN_ENCRYPTION_KEYS[0]!,
        Encrypter: GanGen3CubeEncrypter,
        createDriver: () => new GanGen3ProtocolDriver(),
        validate: isValidGanGen3Packet,
    },
    {
        generation: 'gen4',
        service: def.GAN_GEN4_SERVICE,
        command: def.GAN_GEN4_COMMAND_CHARACTERISTIC,
        state: def.GAN_GEN4_STATE_CHARACTERISTIC,
        key: () => def.GAN_ENCRYPTION_KEYS[0]!,
        Encrypter: GanGen4CubeEncrypter,
        createDriver: () => new GanGen4ProtocolDriver(),
        validate: isValidGanGen4Packet,
    },
];

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
    mac: string,
    options?: { events$?: Subject<GanCubeEvent> }
): Promise<{ conn: GanCubeConnection; generation: GanGeneration } | null> {
    for (const setup of GAN_GENERATION_SETUPS) {
        if (!serviceUuids.has(normalizeUuid(setup.service))) {
            continue;
        }
        // MAC bytes in reverse order salt the per-generation AES key/iv. Parsed only
        // once a supported service matched, so an invalid MAC cannot preempt the
        // documented null result for unsupported profiles.
        const salt = macStringToSaltOrThrow(mac);
        const service = await gatt.getPrimaryService(setup.service);
        const commandCharacteristic = await service.getCharacteristic(setup.command);
        const stateCharacteristic = await service.getCharacteristic(setup.state);
        const key = setup.key(device);
        const encrypter = new setup.Encrypter(Uint8Array.from(key.key), Uint8Array.from(key.iv), salt);
        const conn = await GanCubeClassicConnection.create(
            device,
            commandCharacteristic,
            stateCharacteristic,
            encrypter,
            setup.createDriver(),
            { validateDecrypted: setup.validate, events$: options?.events$, mac }
        );
        return { conn, generation: setup.generation };
    }
    return null;
}
