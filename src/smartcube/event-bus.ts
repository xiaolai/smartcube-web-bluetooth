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
    private forcedBatteryEmissions = 0;
    private emitting = false;
    private readonly pendingEmits: SmartCubeEvent[] = [];

    readonly events$: Observable<SmartCubeEvent> = this.live.asObservable();
    readonly state$: Observable<SmartCubeSnapshot> = this.state.asObservable();

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

    /**
     * Update the snapshot synchronously, then forward the event to live subscribers.
     * A subscriber that emits reentrantly has its event queued until the current
     * delivery finishes, so every subscriber observes events in emission order.
     * BATTERY events are routed through the single clamp/dedupe policy.
     */
    emit(event: SmartCubeEvent): void {
        if (this.stopped) {
            return;
        }
        if (event.type === 'BATTERY') {
            this.emitBattery(event.batteryLevel, event.timestamp);
            return;
        }
        this.emitOrdered(event);
    }

    private emitOrdered(event: SmartCubeEvent): void {
        if (this.emitting) {
            this.pendingEmits.push(event);
            return;
        }
        this.emitting = true;
        try {
            this.dispatch(event);
            while (this.pendingEmits.length > 0) {
                this.dispatch(this.pendingEmits.shift()!);
            }
        } finally {
            this.emitting = false;
        }
    }

    private dispatch(event: SmartCubeEvent): void {
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
        if (this.stopped) {
            return;
        }
        if (!Number.isFinite(rawLevel)) {
            return;
        }
        const batteryLevel = Math.min(100, Math.max(0, Math.round(rawLevel)));
        const forceEmission = this.forcedBatteryEmissions > 0;
        if (forceEmission) {
            this.forcedBatteryEmissions--;
        }
        if (!forceEmission && this.lastBatteryLevel === batteryLevel) {
            return;
        }
        this.lastBatteryLevel = batteryLevel;
        this.emitOrdered({ timestamp, type: 'BATTERY', batteryLevel });
    }

    /**
     * The next emitBattery emits even when the level is unchanged (REQUEST_BATTERY
     * semantics). Forces are counted, so concurrent requests each get an emission.
     */
    forceNextBattery(): void {
        this.forcedBatteryEmissions++;
    }

    /** Roll back one forceNextBattery() after its request failed to reach the cube. */
    cancelForcedBattery(): void {
        this.forcedBatteryEmissions = Math.max(0, this.forcedBatteryEmissions - 1);
    }

    resetBatteryDedupe(): void {
        this.lastBatteryLevel = null;
        this.forcedBatteryEmissions = 0;
    }

    /** Capability changes (e.g. lazy gyro detection) go through the bus so the snapshot stays true. */
    setCapabilities(patch: Partial<SmartCubeCapabilities>): void {
        if (this.stopped) {
            return;
        }
        // Drop explicitly-undefined patch values so a spread cannot violate the
        // snapshot's boolean capability types at runtime.
        const clean: Partial<SmartCubeCapabilities> = {};
        for (const [key, value] of Object.entries(patch)) {
            if (typeof value === 'boolean') {
                (clean as Record<string, boolean>)[key] = value;
            }
        }
        const capabilities = Object.freeze({ ...this.snapshot.capabilities, ...clean });
        const hardware =
            this.snapshot.hardware && clean.gyroscope !== undefined
                ? Object.freeze({ ...this.snapshot.hardware, gyroSupported: clean.gyroscope })
                : this.snapshot.hardware;
        const unchanged =
            hardware === this.snapshot.hardware &&
            Object.entries(capabilities).every(
                ([key, value]) => this.snapshot.capabilities[key as keyof SmartCubeCapabilities] === value,
            );
        if (unchanged) {
            return; // no spurious revisions/state emissions for no-op patches
        }
        this.publish({ capabilities, hardware });
    }

    /** Marks the connection disconnected and completes both streams; later emits are ignored. */
    complete(): void {
        if (this.stopped) {
            return;
        }
        if (this.snapshot.connected) {
            this.publish({ connected: false });
        }
        this.stopped = true;
        this.live.complete();
        this.state.complete();
    }
}
