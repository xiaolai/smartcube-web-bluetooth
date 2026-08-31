import { Observable, ReplaySubject, Subject } from 'rxjs';
import { now } from '../utils';
import type {
    SmartCubeCapabilities,
    SmartCubeEvent,
    SmartCubeSnapshot,
} from './types';

/**
 * Per-connection event bus. Live events pass through `events$` unchanged (deliberately
 * live-only: replaying state into it would change the meaning of `take(1)`/`firstValueFrom`
 * and event counting for existing consumers). The cacheable state — facelets, battery,
 * hardware, capabilities, connected — is maintained as an immutable, revisioned snapshot
 * published through `state$` (current value replayed to each new subscriber) and
 * `getSnapshot()`. The snapshot is updated synchronously before the event reaches
 * subscribers, so reading `getSnapshot()` inside an event callback always reflects it.
 */
export class SmartCubeEventBus {
    private readonly live = new Subject<SmartCubeEvent>();
    private readonly state = new ReplaySubject<SmartCubeSnapshot>(1);
    private snapshot: SmartCubeSnapshot;
    private stopped = false;

    private lastBatteryLevel: number | null = null;
    private forceNextBatteryEmission = false;

    readonly events$: Observable<SmartCubeEvent> = this.live;
    readonly state$: Observable<SmartCubeSnapshot> = this.state;

    constructor(capabilities: SmartCubeCapabilities) {
        this.snapshot = Object.freeze({
            revision: 0,
            connected: true,
            facelets: null,
            battery: null,
            hardware: null,
            capabilities: Object.freeze({ ...capabilities }),
        });
        this.state.next(this.snapshot);
    }

    getSnapshot(): SmartCubeSnapshot {
        return this.snapshot;
    }

    get capabilities(): Readonly<SmartCubeCapabilities> {
        return this.snapshot.capabilities;
    }

    private publish(patch: Partial<Omit<SmartCubeSnapshot, 'revision'>>): void {
        this.snapshot = Object.freeze({
            ...this.snapshot,
            ...patch,
            revision: this.snapshot.revision + 1,
        });
        this.state.next(this.snapshot);
    }

    /** Update the snapshot synchronously, then forward the event to live subscribers. */
    emit(event: SmartCubeEvent): void {
        if (this.stopped) {
            return;
        }
        switch (event.type) {
            case 'FACELETS':
                this.publish({ facelets: Object.freeze({ value: event.facelets, timestamp: event.timestamp }) });
                break;
            case 'BATTERY':
                this.publish({ battery: Object.freeze({ value: event.batteryLevel, timestamp: event.timestamp }) });
                break;
            case 'HARDWARE': {
                const { type: _type, ...fields } = event;
                this.publish({ hardware: Object.freeze(fields) });
                break;
            }
            case 'DISCONNECT':
                this.publish({ connected: false });
                break;
            default:
                break;
        }
        this.live.next(event);
    }

    /**
     * Clamp, deduplicate and emit a BATTERY event — one policy for every driver: repeated
     * identical levels are dropped unless an explicit REQUEST_BATTERY forced the next emission.
     */
    emitBattery(rawLevel: number, timestamp = now()): void {
        if (!Number.isFinite(rawLevel)) {
            return;
        }
        const batteryLevel = Math.min(100, Math.max(0, Math.round(rawLevel)));
        const forceEmission = this.forceNextBatteryEmission;
        this.forceNextBatteryEmission = false;
        if (!forceEmission && this.lastBatteryLevel === batteryLevel) {
            return;
        }
        this.lastBatteryLevel = batteryLevel;
        this.emit({ timestamp, type: 'BATTERY', batteryLevel });
    }

    /** The next emitBattery emits even when the level is unchanged (REQUEST_BATTERY semantics). */
    forceNextBattery(): void {
        this.forceNextBatteryEmission = true;
    }

    resetBatteryDedupe(): void {
        this.lastBatteryLevel = null;
        this.forceNextBatteryEmission = false;
    }

    /** Capability changes (e.g. lazy gyro detection) go through the bus so the snapshot stays true. */
    setCapabilities(patch: Partial<SmartCubeCapabilities>): void {
        if (this.stopped) {
            return;
        }
        const capabilities = Object.freeze({ ...this.snapshot.capabilities, ...patch });
        const hardware =
            this.snapshot.hardware && patch.gyroscope !== undefined
                ? Object.freeze({ ...this.snapshot.hardware, gyroSupported: patch.gyroscope })
                : this.snapshot.hardware;
        this.publish({ capabilities, hardware });
    }

    /** Marks the connection disconnected and completes both streams; later emits are ignored. */
    complete(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        if (this.snapshot.connected) {
            this.snapshot = Object.freeze({
                ...this.snapshot,
                connected: false,
                revision: this.snapshot.revision + 1,
            });
            this.state.next(this.snapshot);
        }
        this.live.complete();
        this.state.complete();
    }
}
