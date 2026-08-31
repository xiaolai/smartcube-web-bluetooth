import { describe, it, expect } from 'vitest';
import { SmartCubeEventBus } from '../../smartcube/event-bus';
import type { SmartCubeEvent, SmartCubeSnapshot } from '../../smartcube/types';

const CAPS = { gyroscope: false, battery: true, facelets: true, hardware: true, reset: false };
const F = (c: string): string => c.repeat(54);

describe('SmartCubeEventBus', () => {
  it('updates the snapshot before delivering the event (atomic for event callbacks)', () => {
    const bus = new SmartCubeEventBus(CAPS);
    let seen: SmartCubeSnapshot | null = null;
    bus.events$.subscribe((e) => {
      if (e.type === 'FACELETS') seen = bus.getSnapshot();
    });
    bus.emit({ timestamp: 5, type: 'FACELETS', facelets: F('X') });
    expect(seen!.facelets).toEqual({ value: F('X'), timestamp: 5 });
  });

  it('replays the current snapshot once to each new state$ subscriber, then updates', () => {
    const bus = new SmartCubeEventBus(CAPS);
    bus.emit({ timestamp: 1, type: 'FACELETS', facelets: F('A') });
    const got: SmartCubeSnapshot[] = [];
    bus.state$.subscribe((s) => got.push(s));
    expect(got).toHaveLength(1);
    expect(got[0]!.facelets?.value).toBe(F('A'));
    bus.emitBattery(80, 2);
    expect(got).toHaveLength(2);
    expect(got[1]!.battery).toEqual({ value: 80, timestamp: 2 });
  });

  it('revisions increase strictly and snapshots are frozen', () => {
    const bus = new SmartCubeEventBus(CAPS);
    const revs: number[] = [];
    bus.state$.subscribe((s) => revs.push(s.revision));
    bus.emit({ timestamp: 1, type: 'FACELETS', facelets: F('B') });
    bus.emitBattery(50);
    bus.setCapabilities({ gyroscope: true });
    expect(revs).toEqual([0, 1, 2, 3]);
    expect(Object.isFrozen(bus.getSnapshot())).toBe(true);
    expect(Object.isFrozen(bus.getSnapshot().capabilities)).toBe(true);
    expect(() => {
      (bus.getSnapshot() as { revision: number }).revision = 99;
    }).toThrow();
  });

  it('keeps hardware.gyroSupported consistent with capability flips', () => {
    const bus = new SmartCubeEventBus(CAPS);
    bus.emit({ timestamp: 1, type: 'HARDWARE', hardwareName: 'X', gyroSupported: false });
    bus.setCapabilities({ gyroscope: true });
    const s = bus.getSnapshot();
    expect(s.capabilities.gyroscope).toBe(true);
    expect(s.hardware?.gyroSupported).toBe(true);
  });

  it('deduplicates battery levels; forceNextBattery lets one duplicate through', () => {
    const bus = new SmartCubeEventBus(CAPS);
    const events: SmartCubeEvent[] = [];
    bus.events$.subscribe((e) => events.push(e));
    bus.emitBattery(80, 1);
    bus.emitBattery(80, 2);
    bus.forceNextBattery();
    bus.emitBattery(80, 3);
    expect(events.map((e) => e.timestamp)).toEqual([1, 3]);
  });

  it('disconnect lifecycle: connected flips, streams complete, later emits are ignored', () => {
    const bus = new SmartCubeEventBus(CAPS);
    const states: SmartCubeSnapshot[] = [];
    let completed = 0;
    bus.state$.subscribe({ next: (s) => states.push(s), complete: () => completed++ });
    bus.events$.subscribe({ complete: () => completed++ });
    bus.emit({ timestamp: 1, type: 'DISCONNECT' });
    bus.complete();
    bus.emit({ timestamp: 2, type: 'FACELETS', facelets: F('C') });
    expect(states[states.length - 1]!.connected).toBe(false);
    expect(completed).toBe(2);
    expect(bus.getSnapshot().facelets).toBeNull();

    // A late subscriber still receives the final snapshot, then completion.
    const late: SmartCubeSnapshot[] = [];
    let lateComplete = false;
    bus.state$.subscribe({
      next: (s) => late.push(s),
      complete: () => {
        lateComplete = true;
      },
    });
    expect(late).toHaveLength(1);
    expect(late[0]!.connected).toBe(false);
    expect(lateComplete).toBe(true);
  });
});

describe('SmartCubeEventBus hardening', () => {
  const M = (n: number): SmartCubeEvent => ({ timestamp: n, type: 'MOVE', move: 'R', face: 3, direction: 0, localTimestamp: n, cubeTimestamp: null });

  it('delivers reentrant emissions to every subscriber in emission order', () => {
    const bus = new SmartCubeEventBus(CAPS);
    const seenByB: number[] = [];
    let emitted = false;
    bus.events$.subscribe((e) => {
      if (!emitted) {
        emitted = true;
        bus.emit(M(2)); // subscriber A reacts to the first move by emitting another
      }
    });
    bus.events$.subscribe((e) => seenByB.push(e.timestamp));
    bus.emit(M(1));
    expect(seenByB).toEqual([1, 2]);
  });

  it('does not expose Subject mutators on the public streams', () => {
    const bus = new SmartCubeEventBus(CAPS);
    expect((bus.events$ as unknown as { next?: unknown }).next).toBeUndefined();
    expect((bus.state$ as unknown as { next?: unknown }).next).toBeUndefined();
  });

  it('counts concurrent battery forces individually', () => {
    const bus = new SmartCubeEventBus(CAPS);
    const events: number[] = [];
    bus.events$.subscribe((e) => {
      if (e.type === 'BATTERY') events.push(e.batteryLevel);
    });
    bus.emitBattery(80);
    bus.forceNextBattery();
    bus.forceNextBattery();
    bus.emitBattery(80); // forced #1
    bus.emitBattery(80); // forced #2
    bus.emitBattery(80); // deduplicated again
    expect(events).toEqual([80, 80, 80]);
  });

  it('cancelForcedBattery rolls back a force whose request failed', () => {
    const bus = new SmartCubeEventBus(CAPS);
    const events: number[] = [];
    bus.events$.subscribe((e) => {
      if (e.type === 'BATTERY') events.push(e.batteryLevel);
    });
    bus.emitBattery(80);
    bus.forceNextBattery();
    bus.cancelForcedBattery();
    bus.emitBattery(80);
    expect(events).toEqual([80]);
  });

  it('routes emit() BATTERY events through the clamp/dedupe policy', () => {
    const bus = new SmartCubeEventBus(CAPS);
    const events: number[] = [];
    bus.events$.subscribe((e) => {
      if (e.type === 'BATTERY') events.push(e.batteryLevel);
    });
    bus.emit({ timestamp: 1, type: 'BATTERY', batteryLevel: 150 });
    bus.emit({ timestamp: 2, type: 'BATTERY', batteryLevel: 100 });
    expect(events).toEqual([100]);
    expect(bus.getSnapshot().battery?.value).toBe(100);
  });

  it('does not publish a new revision for a no-op capability patch', () => {
    const bus = new SmartCubeEventBus(CAPS);
    const before = bus.getSnapshot().revision;
    bus.setCapabilities({ gyroscope: false });
    bus.setCapabilities({ gyroscope: undefined as unknown as boolean });
    expect(bus.getSnapshot().revision).toBe(before);
    expect(bus.getSnapshot().capabilities.gyroscope).toBe(false);
  });
});
