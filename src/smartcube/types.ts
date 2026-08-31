
import { Observable } from 'rxjs';

type SmartCubeMoveEvent = {
    type: "MOVE";
    /** Turned face: 0 = U, 1 = R, 2 = F, 3 = D, 4 = L, 5 = B */
    face: number;
    /** Turn direction: 0 = clockwise, 1 = counter-clockwise, 2 = half turn (only cubes that report a 180° turn as one move) */
    direction: number;
    /** Move in standard notation, e.g. "R", "U'", "F2" */
    move: string;
    /** Host clock at receipt (same clock as `timestamp`); null for moves recovered from history */
    localTimestamp: number | null;
    /** Cube-internal clock in milliseconds where the cube reports one, otherwise null; not comparable across brands (see cubeTimestampLinearFit) */
    cubeTimestamp: number | null;
    /**
     * The cube's own move counter, where the protocol has one. Undefined otherwise — currently
     * only the GAN protocols number their moves.
     *
     * Rolling and modulo 256, so compare with `(a - b) & 0xFF` rather than `>`; a plain
     * comparison misses every gap that crosses the wrap.
     *
     * Why it is worth exposing even though this library never emits a gap: a consumer that also
     * receives FACELETS needs to know WHICH move a given snapshot reflects, and moves and
     * snapshots share this counter. Without it a consumer cannot tell a snapshot taken before a
     * move from one taken after it, and anything timing a solve from those two streams is
     * measuring an interval it cannot vouch for. A consumer cannot reconstruct this by counting
     * the moves it received — that orders what arrived, while this says what the CUBE counted.
     */
    serial?: number;
};

type SmartCubeFaceletsEvent = {
    type: "FACELETS";
    facelets: string;
    /** The move counter this state reflects, where the protocol reports one (GAN only today).
     *  Shares its numbering with `SmartCubeMoveEvent.serial`, which is what makes it possible to
     *  order a snapshot against the move stream. */
    serial?: number;
};

type Vector3 = { x: number; y: number; z: number };
type Quaternion = { x: number; y: number; z: number; w: number };

type SmartCubeGyroEvent = {
    type: "GYRO";
    quaternion: Quaternion;
    velocity?: Vector3;
};

type SmartCubeBatteryEvent = {
    type: "BATTERY";
    batteryLevel: number;
};

type SmartCubeProtocolInfo = {
    readonly id: string;
    readonly name: string;
};

type SmartCubeHardwareEvent = {
    type: "HARDWARE";
    hardwareName?: string;
    softwareVersion?: string;
    hardwareVersion?: string;
    productDate?: string;
    gyroSupported?: boolean;
};

type SmartCubeDisconnectEvent = {
    type: "DISCONNECT";
};

type SmartCubeEventMessage =
    | SmartCubeMoveEvent
    | SmartCubeFaceletsEvent
    | SmartCubeGyroEvent
    | SmartCubeBatteryEvent
    | SmartCubeHardwareEvent
    | SmartCubeDisconnectEvent;

type SmartCubeEvent = {
    /** Host clock at emission, in milliseconds (performance.now()-based where available; not an epoch time) */
    timestamp: number;
} & SmartCubeEventMessage;

type SmartCubeCommand =
    | { type: "REQUEST_FACELETS" }
    | { type: "REQUEST_BATTERY" }
    | { type: "REQUEST_HARDWARE" }
    | { type: "REQUEST_RESET" };

interface SmartCubeCapabilities {
    gyroscope: boolean;
    battery: boolean;
    facelets: boolean;
    hardware: boolean;
    reset: boolean;
}

/**
 * Immutable, revisioned view of the connection's cacheable state. The events stream is
 * live-only (a Subject does not replay), so state observed before a consumer subscribes
 * is available here instead of being lost.
 */
type SmartCubeSnapshot = {
    /** Strictly increasing with every snapshot change on this connection */
    readonly revision: number;
    /** False once the connection disconnected */
    readonly connected: boolean;
    readonly facelets: { readonly value: string; readonly timestamp: number } | null;
    readonly battery: { readonly value: number; readonly timestamp: number } | null;
    readonly hardware: (Readonly<Omit<SmartCubeHardwareEvent, 'type'>> & { readonly timestamp: number }) | null;
    readonly capabilities: Readonly<SmartCubeCapabilities>;
};

interface SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly protocol: SmartCubeProtocolInfo;
    /** Current capabilities (frozen; may change after connect, e.g. lazy gyroscope detection). */
    readonly capabilities: Readonly<SmartCubeCapabilities>;
    /** Live events only; state observed before subscription is available via state$ / getSnapshot(). */
    readonly events$: Observable<SmartCubeEvent>;
    /** Replays the current snapshot to each new subscriber, then every change; completes after disconnect. */
    readonly state$: Observable<SmartCubeSnapshot>;
    /** The current snapshot (frozen; a new object per revision). */
    getSnapshot(): SmartCubeSnapshot;
    sendCommand(command: SmartCubeCommand): Promise<void>;
    disconnect(): Promise<void>;
}

/**
 * Custom source for the cube's Bluetooth MAC address. Called up to twice per connect:
 * first with `isFallbackCall` falsy (return null to let automatic resolution continue),
 * and again with `isFallbackCall: true` as the last resort once every automatic source
 * has been exhausted.
 */
type MacAddressProvider = (device: BluetoothDevice, isFallbackCall?: boolean) => Promise<string | null>;

export type {
    Vector3,
    Quaternion,
    SmartCubeEvent,
    SmartCubeEventMessage,
    SmartCubeMoveEvent,
    SmartCubeFaceletsEvent,
    SmartCubeGyroEvent,
    SmartCubeBatteryEvent,
    SmartCubeProtocolInfo,
    SmartCubeHardwareEvent,
    SmartCubeDisconnectEvent,
    SmartCubeCommand,
    SmartCubeCapabilities,
    SmartCubeConnection,
    SmartCubeSnapshot,
    MacAddressProvider
};
