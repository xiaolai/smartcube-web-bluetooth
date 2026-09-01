import type { SmartCubeEvent, SmartCubeConnection } from '../../smartcube/types';
import { moveDirectionFromNotation } from '../../smartcube/cubie-cube';

// SUPERSEDED: never imported by any test.
// export type NormalizedEvent =
//   | { type: 'MOVE'; face: number; direction: number; move: string; cubeTimestamp: number | null }
//   | { type: 'FACELETS'; facelets: string }
//   | { type: 'GYRO'; quaternion: { x: number; y: number; z: number; w: number } }
//   | { type: 'BATTERY'; batteryLevel: number }
//   | {
//       type: 'HARDWARE';
//       hardwareName?: string;
//       softwareVersion?: string;
//       hardwareVersion?: string;
//       productDate?: string;
//       gyroSupported?: boolean;
//     }
//   | { type: 'DISCONNECT' };
//
// export function normalizeEvent(e: SmartCubeEvent): NormalizedEvent {
//   switch (e.type) {
//     case 'MOVE':
//       return {
//         type: 'MOVE',
//         face: e.face,
//         direction: e.direction,
//         move: e.move,
//         cubeTimestamp: e.cubeTimestamp ?? null,
//       };
//     case 'FACELETS':
//       return { type: 'FACELETS', facelets: e.facelets };
//     case 'GYRO':
//       return { type: 'GYRO', quaternion: e.quaternion };
//     case 'BATTERY':
//       return { type: 'BATTERY', batteryLevel: e.batteryLevel };
//     case 'HARDWARE':
//       return {
//         type: 'HARDWARE',
//         hardwareName: (e as any).hardwareName,
//         softwareVersion: (e as any).softwareVersion,
//         hardwareVersion: (e as any).hardwareVersion,
//         productDate: (e as any).productDate,
//         gyroSupported: (e as any).gyroSupported,
//       };
//     case 'DISCONNECT':
//       return { type: 'DISCONNECT' };
//   }
// }

export function collectEvents(conn: SmartCubeConnection): { events: SmartCubeEvent[]; unsubscribe: () => void } {
  const events: SmartCubeEvent[] = [];
  const sub = conn.events$.subscribe({ next: (e) => events.push(e) });
  return { events, unsubscribe: () => sub.unsubscribe() };
}

export function moves(events: SmartCubeEvent[]): string[] {
  return events.filter((e) => e.type === 'MOVE').map((e) => (e as any).move as string);
}

export function lastFacelets(events: SmartCubeEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'FACELETS') return (e as any).facelets as string;
  }
  return null;
}

/**
 * Every MOVE must carry the `face` and `direction` implied by its own notation
 * (0 = CW, 1 = CCW, 2 = half turn). Returns one description per violation.
 */
export function moveDirectionMismatches(events: SmartCubeEvent[]): string[] {
  const out: string[] = [];
  events.forEach((e, i) => {
    if (e.type !== 'MOVE') return;
    const face = 'URFDLB'.indexOf(e.move.charAt(0));
    const direction = moveDirectionFromNotation(e.move);
    if (e.face !== face) out.push(`#${i} ${e.move}: face ${e.face}, expected ${face}`);
    if (e.direction !== direction) out.push(`#${i} ${e.move}: direction ${e.direction}, expected ${direction}`);
  });
  return out;
}

export function fixtureExpectedMoves(fixture: { events: { event: any }[] }, limit?: number): string[] {
  const ms = fixture.events
    .map((e) => e.event)
    .filter((e) => e.type === 'MOVE')
    .map((e) => e.move as string);
  return limit ? ms.slice(0, limit) : ms;
}

export function fixtureExpectedLastFacelets(fixture: { events: { event: any }[] }): string | null {
  for (let i = fixture.events.length - 1; i >= 0; i--) {
    const e = fixture.events[i]!.event;
    if (e.type === 'FACELETS') return (e.facelets as string) ?? null;
  }
  return null;
}

// SUPERSEDED: never imported by any test.
// export async function sendAllSupportedCommands(conn: SmartCubeConnection, commands: SmartCubeCommand[]): Promise<void> {
//   for (const cmd of commands) {
//     try {
//       await conn.sendCommand(cmd);
//     } catch {
//       // Some drivers intentionally ignore unsupported commands; tests should assert behavior separately.
//     }
//   }
// }
