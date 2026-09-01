import { Observable } from 'rxjs';
import { now } from '../utils';
import { SmartCubeEventBus } from './event-bus';
import type {
    SmartCubeCapabilities,
    SmartCubeCommand,
    SmartCubeConnection,
    SmartCubeEvent,
    SmartCubeProtocolInfo,
    SmartCubeSnapshot,
} from './types';

const BATTERY_POLL_INTERVAL_MS = 60_000;

/**
 * Lifecycle shared by every driver that owns its GATT session directly (Giiker, GoCube, MoYu
 * MHC, MoYu32, QiYi): the event-bus facade, the `gattserverdisconnected` hook, and one teardown
 * order — release brand resources, reset battery state, stop polling, emit DISCONNECT, complete
 * the bus — so a lifecycle fix lands once instead of five times. The GAN driver wraps a legacy
 * connection that runs its own GATT lifecycle, so it does not extend this.
 */
export abstract class GattSmartCubeConnection implements SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly protocol: SmartCubeProtocolInfo;
    readonly events$: Observable<SmartCubeEvent>;
    readonly state$: Observable<SmartCubeSnapshot>;

    protected readonly device: BluetoothDevice;
    protected readonly bus: SmartCubeEventBus;
    private batteryInterval: ReturnType<typeof setInterval> | null = null;

    protected constructor(
        device: BluetoothDevice,
        protocol: SmartCubeProtocolInfo,
        deviceName: string,
        deviceMAC: string,
        capabilities: SmartCubeCapabilities
    ) {
        this.device = device;
        this.protocol = protocol;
        this.deviceName = deviceName;
        this.deviceMAC = deviceMAC;
        this.bus = new SmartCubeEventBus(capabilities);
        this.events$ = this.bus.events$;
        this.state$ = this.bus.state$;
    }

    get capabilities(): SmartCubeCapabilities {
        return this.bus.capabilities as SmartCubeCapabilities;
    }

    getSnapshot(): SmartCubeSnapshot {
        return this.bus.getSnapshot();
    }

    abstract sendCommand(command: SmartCubeCommand): Promise<void>;

    /**
     * Drop the listeners and references the brand driver holds. Runs inside every teardown, so
     * it must tolerate a previous teardown having already run.
     */
    protected abstract releaseResources(): void;

    /** Characteristics whose notifications `disconnect()` stops; read before teardown nulls them. */
    protected abstract notifyingCharacteristics(): (BluetoothRemoteGATTCharacteristic | null)[];

    /** Route a remote disconnect through the same teardown as an explicit one. */
    protected watchDisconnect(): void {
        this.device.addEventListener('gattserverdisconnected', this.onDisconnect);
    }

    /** Watch for disconnects, run the brand's GATT setup, and undo everything if it fails. */
    protected async initialize(setup: () => Promise<void>): Promise<void> {
        this.watchDisconnect();
        try {
            await setup();
        } catch (e) {
            this.teardown();
            this.disconnectGatt();
            throw e;
        }
    }

    protected startBatteryPolling(poll: () => void): void {
        this.batteryInterval = setInterval(poll, BATTERY_POLL_INTERVAL_MS);
    }

    protected stopBatteryPolling(): void {
        if (this.batteryInterval) {
            clearInterval(this.batteryInterval);
            this.batteryInterval = null;
        }
    }

    /** HARDWARE for drivers without a hardware-info frame: the model name and the gyro capability. */
    protected emitHardwareEventFromName(): void {
        this.bus.emit({
            timestamp: now(),
            type: "HARDWARE",
            hardwareName: this.deviceName,
            gyroSupported: this.capabilities.gyroscope
        });
    }

    /** Idempotent teardown shared by remote and explicit disconnects. */
    protected teardown(): void {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.releaseResources();
        this.bus.resetBatteryDedupe();
        this.stopBatteryPolling();
        this.bus.emit({ timestamp: now(), type: "DISCONNECT" });
        this.bus.complete();
    }

    private readonly onDisconnect = (): void => {
        this.teardown();
    };

    protected disconnectGatt(): void {
        if (this.device.gatt?.connected) {
            this.device.gatt.disconnect();
        }
    }

    /** Work that must settle between teardown and stopping notifications (e.g. queued writes). */
    protected async settleBeforeStopNotifications(): Promise<void> {}

    async disconnect(): Promise<void> {
        const notifying = this.notifyingCharacteristics();
        this.teardown();
        await this.settleBeforeStopNotifications();
        for (const chrct of notifying) {
            if (chrct) {
                await chrct.stopNotifications().catch(() => {});
            }
        }
        this.disconnectGatt();
    }
}
