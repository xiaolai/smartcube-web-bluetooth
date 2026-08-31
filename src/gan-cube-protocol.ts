
import { now } from './utils';
import { GanCubeEncrypter } from './gan-cube-encrypter';
import { writeGattCharacteristicValue } from './gatt-characteristic-write';
import { Observable, Subject } from 'rxjs';

/**
 * Command message: request hardware info, current facelets, battery level, or reset the
 * cube's internal state to solved.
 */
type GanCubeCommand = {
    type: "REQUEST_HARDWARE" | "REQUEST_FACELETS" | "REQUEST_BATTERY" | "REQUEST_RESET";
};

/** 
 * Representation of GAN Smart Cube move
 */
type GanCubeMove = {
    /** Face: 0 - U, 1 - R, 2 - F, 3 - D, 4 - L, 5 - B */
    face: number;
    /** Face direction: 0 - CW, 1 - CCW */
    direction: number;
    /** Cube move in common string notation, like R' or U */
    move: string;
    /** Timestamp according to host device clock, null in case if bluetooth event was missed and recovered */
    localTimestamp: number | null;
    /** Timestamp according to cube internal clock, for some cube models may be null in case if bluetooth event was missed and recovered */
    cubeTimestamp: number | null;
};

/**
 * Move event
 */
type GanCubeMoveEvent = {
    type: "MOVE";
    /** Serial number, value range 0-255, increased in a circle on each facelets state change */
    serial: number;
} & GanCubeMove;

/**
 * Representation of GAN Smart Cube facelets state
 */
type GanCubeState = {
    /** Corner Permutation: 8 elements, values from 0 to 7 */
    CP: Array<number>;
    /** Corner Orientation: 8 elements, values from 0 to 2 */
    CO: Array<number>;
    /** Edge Permutation: 12 elements, values from 0 to 11 */
    EP: Array<number>;
    /** Edge Orientation: 12 elements, values from 0 to 1 */
    EO: Array<number>;
};

/**
 * Facelets event
 */
type GanCubeFaceletsEvent = {
    type: "FACELETS";
    /** Serial number, value range 0-255, increased in a circle on each facelets state change */
    serial: number;
    /** Cube facelets state in the Kociemba notation like "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB" */
    facelets: string;
    /** Cube state representing corners and edges orientation and permutation */
    state: GanCubeState;
};

/**
 * Quaternion to represent orientation
 */
type GanCubeOrientationQuaternion = {
    x: number;
    y: number;
    z: number;
    w: number;
};

/**
 * Representation of angular velocity by axes
 */
type GanCubeAngularVelocity = {
    x: number;
    y: number;
    z: number;
};

/**
 * Gyroscope event
 */
type GanCubeGyroEvent = {
    type: "GYRO";
    /** Cube orientation quaternion, uses Right-Handed coordinate system, +X - Red, +Y - Blue, +Z - White */
    quaternion: GanCubeOrientationQuaternion;
    /** Cube angular velocity over current ODR time frame */
    velocity?: GanCubeAngularVelocity;
};

/**
 * Battery event
 */
type GanCubeBatteryEvent = {
    type: "BATTERY";
    /** Current battery level in percent */
    batteryLevel: number;
};

/**
 * Hardware event
 */
type GanCubeHardwareEvent = {
    type: "HARDWARE";
    /** Internal cube hardware device model name */
    hardwareName?: string;
    /** Software/Firmware version of the cube */
    softwareVersion?: string;
    /** Hardware version of the cube */
    hardwareVersion?: string;
    /** Production Date of the cube */
    productDate?: string;
    /** Is gyroscope supported by this cube model */
    gyroSupported?: boolean;
};

/**
 * Disconnect event
 */
type GanCubeDisconnectEvent = {
    type: "DISCONNECT";
};

/** All possible event message types */
type GanCubeEventMessage = GanCubeMoveEvent | GanCubeFaceletsEvent | GanCubeGyroEvent | GanCubeBatteryEvent | GanCubeHardwareEvent | GanCubeDisconnectEvent;
/** Cube event / response to command */
type GanCubeEvent = { timestamp: number } & GanCubeEventMessage;

/** Extention to the BluetoothDevice for storing and accessing device MAC address */
interface BluetoothDeviceWithMAC extends BluetoothDevice {
    mac?: string;
};

/**
 * Connection object representing connection API and state
 */
interface GanCubeConnection {
    /** Connected Bluetooth cube device name */
    readonly deviceName: string;
    /** Connected Bluetoooth cube device MAC address */
    readonly deviceMAC: string;
    /** RxJS Subject to subscribe for cube event messages */
    events$: Observable<GanCubeEvent>;
    /** Method to send command to the cube */
    sendCubeCommand(command: GanCubeCommand): Promise<void>;
    /** Close this connection */
    disconnect(): Promise<void>;
}

/** Raw connection interface for internal use */
interface GanCubeRawConnection {
    sendCommandMessage(message: Uint8Array): Promise<void>;
    disconnect(): Promise<void>;
}

/** Protocol Driver interface */
interface GanProtocolDriver {
    /** Create binary command message for cube device */
    createCommandMessage(command: GanCubeCommand): Uint8Array | undefined;
    /** Handle binary event messages from cube device */
    handleStateEvent(conn: GanCubeRawConnection, eventMessage: Uint8Array): Promise<GanCubeEvent[]>;
}

/** Optional hooks for {@link GanCubeClassicConnection.create}. */
export type GanClassicConnectionOptions = {
    /** If set, decrypted payloads that fail this check are dropped (wrong MAC / noise). */
    validateDecrypted?: (plaintext: Uint8Array) => boolean;
    /** Subject to emit into; lets a caller observe events emitted while create() is still running. */
    events$?: Subject<GanCubeEvent>;
    /** The resolved cube MAC; avoids mutating the browser-owned BluetoothDevice object. */
    mac?: string;
};

/**
 * Implementation of classic command/response connection with GAN Smart Cube device
 */
class GanCubeClassicConnection implements GanCubeConnection, GanCubeRawConnection {

    readonly device: BluetoothDeviceWithMAC;
    readonly commandCharacteristic: BluetoothRemoteGATTCharacteristic;
    readonly stateCharacteristic: BluetoothRemoteGATTCharacteristic;

    readonly encrypter: GanCubeEncrypter;
    readonly driver: GanProtocolDriver;

    readonly events$: Subject<GanCubeEvent>;

    private readonly validateDecrypted?: (plaintext: Uint8Array) => boolean;
    private readonly explicitMac: string | null;
    private disconnectOnce = false;
    private inNotificationHandler = false;

    private constructor(
        device: BluetoothDeviceWithMAC,
        commandCharacteristic: BluetoothRemoteGATTCharacteristic,
        stateCharacteristic: BluetoothRemoteGATTCharacteristic,
        encrypter: GanCubeEncrypter,
        driver: GanProtocolDriver,
        validateDecrypted?: (plaintext: Uint8Array) => boolean,
        events$?: Subject<GanCubeEvent>,
        explicitMac?: string
    ) {
        this.device = device;
        this.commandCharacteristic = commandCharacteristic;
        this.stateCharacteristic = stateCharacteristic;
        this.encrypter = encrypter;
        this.driver = driver;
        this.validateDecrypted = validateDecrypted;
        this.events$ = events$ ?? new Subject<GanCubeEvent>();
        this.explicitMac = explicitMac ?? null;
    }

    public static async create(
        device: BluetoothDeviceWithMAC,
        commandCharacteristic: BluetoothRemoteGATTCharacteristic,
        stateCharacteristic: BluetoothRemoteGATTCharacteristic,
        encrypter: GanCubeEncrypter,
        driver: GanProtocolDriver,
        options?: GanClassicConnectionOptions
    ): Promise<GanCubeConnection> {
        const conn = new GanCubeClassicConnection(
            device,
            commandCharacteristic,
            stateCharacteristic,
            encrypter,
            driver,
            options?.validateDecrypted,
            options?.events$,
            options?.mac
        );
        conn.device.addEventListener('gattserverdisconnected', conn.onDisconnect);
        conn.stateCharacteristic.addEventListener('characteristicvaluechanged', conn.onStateUpdate);
        try {
            await conn.stateCharacteristic.startNotifications();
        } catch (e) {
            // Undo partial setup: a failed startup must not leave listeners installed.
            conn.device.removeEventListener('gattserverdisconnected', conn.onDisconnect);
            conn.stateCharacteristic.removeEventListener('characteristicvaluechanged', conn.onStateUpdate);
            throw e;
        }
        if (conn.disconnectOnce) {
            throw new Error('Device disconnected during connection setup');
        }
        return conn;
    }

    /** Legacy API contract: an unnamed device reports "GAN-XXXX", never null. */
    get deviceName(): string {
        return this.device.name || "GAN-XXXX";
    }

    /** Legacy API contract: an unknown MAC reports the zero address, never null. */
    get deviceMAC(): string {
        return this.explicitMac || this.device.mac || "00:00:00:00:00:00";
    }

    async sendCommandMessage(message: Uint8Array): Promise<void> {
        const encryptedMessage = this.encrypter.encrypt(message);
        // writeGattCharacteristicValue already serializes writes per device.
        return writeGattCharacteristicValue(this.commandCharacteristic, encryptedMessage as BufferSource);
    }

    /**
     * Notifications are processed strictly in arrival order. handleStateEvent can await a GATT
     * write (move-history request); without the chain a later notification could finish first
     * and emit its recovered moves before the earlier one's, reordering MOVE events.
     */
    private notificationChain: Promise<void> = Promise.resolve();

    onStateUpdate = (evt: Event): void => {
        const characteristic = evt.target as BluetoothRemoteGATTCharacteristic;
        const eventMessage = characteristic.value;
        if (!eventMessage || eventMessage.byteLength < 16) return;
        // Copy now: the platform may reuse the DataView's buffer before the queued handler runs.
        const raw = new Uint8Array(
            eventMessage.buffer.slice(eventMessage.byteOffset, eventMessage.byteOffset + eventMessage.byteLength)
        );
        // The catch is a backstop invariant: a rejected chain would silently skip every
        // subsequent notification, so no failure may ever leave it rejected.
        this.notificationChain = this.notificationChain
            .then(() => this.handleNotification(raw))
            .catch((e) => {
                console.error('[gan] notification handler failed; frame dropped', e);
            });
    }

    private async handleNotification(raw: Uint8Array): Promise<void> {
        this.inNotificationHandler = true;
        try {
            let decryptedMessage: Uint8Array;
            try {
                decryptedMessage = this.encrypter.decrypt(raw);
            } catch {
                return; // not a whole number of AES blocks: corrupt frame
            }
            try {
                if (this.validateDecrypted && !this.validateDecrypted(decryptedMessage)) return;
            } catch (e) {
                // A throwing validator is a defect, not line noise: drop the frame loudly.
                console.error('[gan] packet validator threw', e);
                return;
            }
            try {
                const cubeEvents = await this.driver.handleStateEvent(this, decryptedMessage);
                cubeEvents.forEach(e => this.events$.next(e));
            } catch (e) {
                // A validated frame failing in the driver is a defect, not line noise:
                // keep the stream alive but make the failure observable.
                console.error('[gan] driver failed to handle a validated frame', e);
            }
        } finally {
            this.inNotificationHandler = false;
        }
    }

    onDisconnect = async (): Promise<void> => {
        if (this.disconnectOnce) return;
        this.disconnectOnce = true;
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.stateCharacteristic.removeEventListener('characteristicvaluechanged', this.onStateUpdate);
        await this.stateCharacteristic.stopNotifications().catch(() => { });
        if (!this.inNotificationHandler) {
            // Drain in-flight notifications so their decoded events are delivered before
            // the stream completes. Skipped when the disconnect originates inside the
            // notification chain itself (awaiting it there would deadlock).
            await this.notificationChain.catch(() => { });
        }
        if (!this.events$.closed) {
            this.events$.next({ timestamp: now(), type: "DISCONNECT" });
            this.events$.complete();
        }
    }

    async sendCubeCommand(command: GanCubeCommand): Promise<void> {
        const commandMessage = this.driver.createCommandMessage(command);
        if (commandMessage) {
            return this.sendCommandMessage(commandMessage);
        }
    }

    async disconnect(): Promise<void> {
        await this.onDisconnect();
        if (this.device.gatt?.connected) {
            this.device.gatt?.disconnect();
        }
    }

}

export type {
    BluetoothDeviceWithMAC,
    GanCubeConnection,
    GanCubeEvent,
    GanCubeCommand,
    GanCubeMove,
    GanCubeMoveEvent,
    GanCubeState,
    GanCubeRawConnection,
    GanProtocolDriver
};

export { GanCubeClassicConnection };
export { GanGen2ProtocolDriver, GanGen3ProtocolDriver, GanGen4ProtocolDriver } from './gan-protocol-drivers';

