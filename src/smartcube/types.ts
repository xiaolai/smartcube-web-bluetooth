
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
};

type SmartCubeFaceletsEvent = {
    type: "FACELETS";
    facelets: string;
};

type SmartCubeGyroEvent = {
    type: "GYRO";
    quaternion: { x: number; y: number; z: number; w: number };
    velocity?: { x: number; y: number; z: number };
};

type SmartCubeBatteryEvent = {
    type: "BATTERY";
    batteryLevel: number;
};

type SmartCubeProtocolInfo = {
    id: string;
    name: string;
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
    /** Current capabilities; may change after connect (e.g. gyroscope support is detected lazily). */
    readonly capabilities: SmartCubeCapabilities;
    /** Live events only; state observed before subscription is available via state$ / getSnapshot(). */
    events$: Observable<SmartCubeEvent>;
    /** Replays the current snapshot to each new subscriber, then every change; completes after disconnect. */
    state$: Observable<SmartCubeSnapshot>;
    /** The current snapshot (frozen; a new object per revision). */
    getSnapshot(): SmartCubeSnapshot;
    sendCommand(command: SmartCubeCommand): Promise<void>;
    disconnect(): Promise<void>;
}

type MacAddressProvider = (device: BluetoothDevice, isFallbackCall?: boolean) => Promise<string | null>;

export type {
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
