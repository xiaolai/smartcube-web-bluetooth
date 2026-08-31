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
