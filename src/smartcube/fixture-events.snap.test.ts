import { describe, it, expect, vi } from 'vitest';
import type { SmartCubeCapabilities, SmartCubeEvent, SmartCubeSnapshot } from './types';
import type { SmartCubeProtocol } from './protocol';
import { FIXTURES, loadFixture } from '../test/fixtures';
import { installMockBluetoothFromFixture } from '../test/bluetooth-mock';
import { attachmentContextFor, serviceUuidsFromFixture } from '../test/helpers/fixture-replay';
import { ganProtocol } from './protocols/gan';
import { giikerProtocol } from './protocols/giiker';
import { goCubeProtocol } from './protocols/gocube';
import { moyu32Protocol } from './protocols/moyu32';
import { qiyiProtocol } from './protocols/qiyi';

/**
 * Full-field characterisation snapshots: every event each fixture decodes to, in order.
 *
 * The other replay tests compare only `move` strings and the last facelets. These snapshots
 * pin `face`, `direction`, `cubeTimestamp`, battery, hardware, gyro and event ordering as well,
 * so a refactor that changes any decoded field shows up as a snapshot diff.
 *
 * Determinism: `now()` reads `performance.now()`, which is mocked to a counter, and MOVE
 * `cubeTimestamp` is stored relative to the first move so clock-derived offsets cancel out.
 * GYRO bursts are collapsed to a run length plus a checksum to keep the files reviewable.
 */

type Case = {
    key: keyof typeof FIXTURES;
    protocol: SmartCubeProtocol;
    /** Same value the corresponding replay test uses, so init consumes the same traffic. */
    maxAutoFlushNotifies?: number;
};

const CASES: Case[] = [
    { key: 'ganGen2_small', protocol: ganProtocol },
    { key: 'ganGen2_gan12ui', protocol: ganProtocol },
    { key: 'ganGen2_gan12uiFreePlay', protocol: ganProtocol },
    { key: 'ganGen4', protocol: ganProtocol, maxAutoFlushNotifies: 0 },
    { key: 'giiker', protocol: giikerProtocol, maxAutoFlushNotifies: 0 },
    { key: 'gocube', protocol: goCubeProtocol, maxAutoFlushNotifies: 5 },
    { key: 'rubiksConnected', protocol: goCubeProtocol, maxAutoFlushNotifies: 1 },
    { key: 'moyu32_my32', protocol: moyu32Protocol, maxAutoFlushNotifies: 0 },
    // Not replayable: fixture_WCU_MY32_A388_moyu32_2026-04-14T11-35-43.json was recorded with an
    // earlier MoYu32 init sequence; its write payloads diverge from the current driver at index 11.
    { key: 'moyu32_my33_noGyro', protocol: moyu32Protocol, maxAutoFlushNotifies: 0 },
    { key: 'qiyi', protocol: qiyiProtocol },
    { key: 'qiyi_xmdTornadoV4', protocol: qiyiProtocol },
];

type Quaternion = { x: number; y: number; z: number; w: number };

type SnapshotEvent =
    | { i: number; type: 'MOVE'; face: number; direction: number; move: string; cubeTimestampRel: number | null; hasLocalTimestamp: boolean }
    | { i: number; type: 'FACELETS'; facelets: string }
    | { i: number; type: 'BATTERY'; batteryLevel: number }
    | { i: number; type: 'HARDWARE'; hardwareName?: string; softwareVersion?: string; hardwareVersion?: string; productDate?: string; gyroSupported?: boolean }
    | { i: number; type: 'DISCONNECT' }
    | { i: number; type: 'GYRO*'; count: number };

type FixtureSnapshot = {
    fixture: string;
    protocol: string;
    deviceName: string;
    capabilitiesAtConnect: SmartCubeCapabilities;
    capabilitiesAfterDrain: SmartCubeCapabilities;
    counts: Record<string, number>;
    gyro: { count: number; checksum: string; first: Quaternion[]; last: Quaternion[] };
    events: SnapshotEvent[];
};

type SnapState = {
    revision: number;
    connected: boolean;
    facelets: { value: string; timestamp: number } | null;
    battery: { value: number; timestamp: number } | null;
    hardware: Record<string, unknown> | null;
    capabilities: SmartCubeCapabilities;
};

function normaliseState(s: SmartCubeSnapshot): SnapState {
    return {
        revision: s.revision,
        connected: s.connected,
        facelets: s.facelets ? { ...s.facelets } : null,
        battery: s.battery ? { ...s.battery } : null,
        hardware: s.hardware ? { ...s.hardware } : null,
        capabilities: { ...s.capabilities },
    };
}

function round6(q: Quaternion): Quaternion {
    const r = (n: number): number => Math.round(n * 1e6) / 1e6 || 0;
    return { x: r(q.x), y: r(q.y), z: r(q.z), w: r(q.w) };
}

/** FNV-1a over the rounded gyro stream; any changed component changes the digest. */
function gyroChecksum(qs: Quaternion[]): string {
    let h = 0x811c9dc5;
    const text = qs.map((q) => `${q.x},${q.y},${q.z},${q.w}`).join(';');
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

function summarise(caseKey: string, protocolId: string, deviceName: string, capsAtConnect: SmartCubeCapabilities, capsAfter: SmartCubeCapabilities, raw: SmartCubeEvent[]): FixtureSnapshot {
    const counts: Record<string, number> = {};
    const gyros: Quaternion[] = [];
    const events: SnapshotEvent[] = [];
    let firstMoveCubeTs: number | null = null;

    raw.forEach((e, i) => {
        counts[e.type] = (counts[e.type] ?? 0) + 1;
        switch (e.type) {
            case 'GYRO': {
                gyros.push(round6(e.quaternion));
                const prev = events[events.length - 1];
                if (prev && prev.type === 'GYRO*') {
                    prev.count++;
                } else {
                    events.push({ i, type: 'GYRO*', count: 1 });
                }
                return;
            }
            case 'MOVE': {
                let rel: number | null = null;
                if (e.cubeTimestamp != null) {
                    if (firstMoveCubeTs === null) {
                        firstMoveCubeTs = e.cubeTimestamp;
                    }
                    rel = e.cubeTimestamp - firstMoveCubeTs;
                }
                events.push({
                    i,
                    type: 'MOVE',
                    face: e.face,
                    direction: e.direction,
                    move: e.move,
                    cubeTimestampRel: rel,
                    hasLocalTimestamp: e.localTimestamp != null,
                });
                return;
            }
            case 'FACELETS':
                events.push({ i, type: 'FACELETS', facelets: e.facelets });
                return;
            case 'BATTERY':
                events.push({ i, type: 'BATTERY', batteryLevel: e.batteryLevel });
                return;
            case 'HARDWARE':
                events.push({
                    i,
                    type: 'HARDWARE',
                    hardwareName: e.hardwareName,
                    softwareVersion: e.softwareVersion,
                    hardwareVersion: e.hardwareVersion,
                    productDate: e.productDate,
                    gyroSupported: e.gyroSupported,
                });
                return;
            case 'DISCONNECT':
                events.push({ i, type: 'DISCONNECT' });
                return;
        }
    });

    return {
        fixture: FIXTURES[caseKey as keyof typeof FIXTURES],
        protocol: protocolId,
        deviceName,
        capabilitiesAtConnect: capsAtConnect,
        capabilitiesAfterDrain: capsAfter,
        counts,
        gyro: {
            count: gyros.length,
            checksum: gyroChecksum(gyros),
            first: gyros.slice(0, 3),
            last: gyros.slice(-3),
        },
        events,
    };
}

describe('fixture event snapshots (full-field characterisation)', () => {
    for (const c of CASES) {
        it(`${c.key}: decodes to the recorded event stream`, async () => {
            // Deterministic host clock: each now() call advances by exactly 1 ms.
            let tick = 0;
            vi.spyOn(performance, 'now').mockImplementation(() => ++tick);

            const fixture = await loadFixture(FIXTURES[c.key]);
            const { device, replayer } = installMockBluetoothFromFixture(fixture, {
                deviceId: `snap-${c.key}`,
                maxAutoFlushNotifies: c.maxAutoFlushNotifies,
            });

            const conn = await c.protocol.connect(device, async () => fixture.device.mac ?? null, attachmentContextFor(serviceUuidsFromFixture(fixture)));
            // SUPERSEDED: attachmentContextFor() builds this literal.
            // {
            //     serviceUuids: serviceUuidsFromFixture(fixture),
            //     advertisementManufacturerData: null,
            //     enableAddressSearch: false,
            //     onStatus: undefined,
            //     signal: undefined,
            // }
            const capsAtConnect = { ...conn.capabilities };
            const stateAtConnect = normaliseState(conn.getSnapshot());

            const raw: SmartCubeEvent[] = [];
            const sub = conn.events$.subscribe({ next: (e) => raw.push(e) });
            await replayer.drainNotificationsAsync();
            const capsAfter = { ...conn.capabilities };
            const stateAfterDrain = normaliseState(conn.getSnapshot());

            // The snapshot mirrors the last observed event of each cacheable type.
            const lastFaceletsEvent = [...raw].reverse().find((e) => e.type === 'FACELETS');
            if (lastFaceletsEvent && lastFaceletsEvent.type === 'FACELETS') {
                expect(stateAfterDrain.facelets?.value).toBe(lastFaceletsEvent.facelets);
            }
            const lastBatteryEvent = [...raw].reverse().find((e) => e.type === 'BATTERY');
            if (lastBatteryEvent && lastBatteryEvent.type === 'BATTERY') {
                expect(stateAfterDrain.battery?.value).toBe(lastBatteryEvent.batteryLevel);
            }
            expect(stateAfterDrain.capabilities).toEqual(capsAfter);

            await conn.disconnect();
            sub.unsubscribe();

            const snapshot = {
                ...summarise(c.key, conn.protocol.id, conn.deviceName, capsAtConnect, capsAfter, raw),
                stateAtConnect,
                stateAfterDrain,
            };
            await expect(JSON.stringify(snapshot, null, 2) + '\n').toMatchFileSnapshot(
                `./__snapshots__/fixture-events/${c.key}.json`
            );
        }, 30_000);
    }
});
