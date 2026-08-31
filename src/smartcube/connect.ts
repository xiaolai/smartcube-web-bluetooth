import { filter, take, TimeoutError, type Subscription } from 'rxjs';
import { buildRequestDeviceOptions } from './attachment/build-picker-options';
import { collectPrimaryServiceUuids } from './attachment/gatt-snapshot';
import { resolveProtocolByGatt } from './attachment/profile-rank';
import { abortError, isAbortError, throwIfAborted } from './attachment/abort';
import {
    removeCachedMacForDevice,
    setCachedMacForDevice,
    waitForManufacturerData,
} from './attachment/address-hints';
import type { ConnectSmartCubeOptions, DeviceSelectionMode } from './attachment/types';
import type { MacAddressProvider, SmartCubeConnection, SmartCubeEvent } from './types';
import { CubieCube } from './cubie-cube';
import { getRegisteredProtocols, type SmartCubeProtocol } from './protocol';

/**
 * MoYu-style payloads always yield 54-char FACELETS from {U,F,R,B,L,D} even when AES decrypt is wrong;
 * event-type checks are insufficient. A legal 3×3 state requires consistent sticker counts + geometry.
 */
function isMacCacheProofEvent(e: SmartCubeEvent): boolean {
    if (e.type !== 'FACELETS') {
        return false;
    }
    return new CubieCube().fromFacelet(e.facelets) !== -1;
}

/**
 * Proof predicate matched to what the cube can actually produce: a legal FACELETS state
 * when the driver supports facelets, otherwise any decoded HARDWARE/BATTERY response —
 * weaker, but a facelets-less cube can never satisfy the strict check, and its driver
 * already validates decodes.
 */
function macProofPredicate(conn: SmartCubeConnection): (e: SmartCubeEvent) => boolean {
    if (conn.capabilities.facelets) {
        return isMacCacheProofEvent;
    }
    return (e) => e.type === 'HARDWARE' || e.type === 'BATTERY';
}

const MAC_VERIFY_TIMEOUT_MS = 10_000;
/** Pre-connect advertisement budget; longer when the slow MAC candidate search is enabled. */
const ADVERTISEMENT_WAIT_MS = 2500;
const ADVERTISEMENT_SEARCH_WAIT_MS = 8000;

/**
 * After we subscribe for MAC proof, ask the cube for a fresh report. Init often emits
 * FACELETS before this subscription exists (Subject does not replay), so without this
 * we can time out even with a correct MAC. Fire-and-forget so a stuck write cannot
 * block verification or leave the UI on "Verifying…" indefinitely.
 */
function requestFreshStateForMacVerify(conn: SmartCubeConnection, onError: (e: unknown) => void): void {
    const c = conn.capabilities;
    const p: Promise<void> = c.facelets
        ? conn.sendCommand({ type: 'REQUEST_FACELETS' })
        : c.hardware
          ? conn.sendCommand({ type: 'REQUEST_HARDWARE' })
          : c.battery
            ? conn.sendCommand({ type: 'REQUEST_BATTERY' })
            : Promise.resolve();
    p.catch(onError);
}

/**
 * Wait until we see decrypted/valid cube traffic so we do not persist a wrong MAC
 * (GAN / MoYu32 / QiYi can complete GATT setup before crypto is proven).
 */
function waitForVerifiedCubeEvent(
    conn: SmartCubeConnection,
    timeoutMs: number,
    signal?: AbortSignal,
    proof: (e: SmartCubeEvent) => boolean = isMacCacheProofEvent
): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let sub: Subscription | undefined;

        const cleanup = (): void => {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            sub?.unsubscribe();
            sub = undefined;
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
        };

        const finish = (action: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            action();
        };

        const onAbort = (): void => {
            finish(() => reject(abortError()));
        };

        if (signal) {
            if (signal.aborted) {
                finish(() => reject(abortError()));
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
        }

        timer = setTimeout(() => {
            finish(() =>
                reject(
                    new TimeoutError({
                        seen: 0,
                        lastValue: null,
                        meta: null,
                    })
                )
            );
        }, timeoutMs);

        sub = conn.events$.pipe(filter(proof), take(1)).subscribe({
            next: () => {
                finish(() => resolve());
            },
            error: (err: unknown) => {
                finish(() => reject(err));
            },
            complete: () => {
                // The connection closed before any proof arrived: fail immediately
                // instead of sitting out the whole timeout.
                finish(() => reject(new Error('Connection closed before cube data could be verified')));
            },
        });
    });
}

function isMacAddressProvider(x: unknown): x is MacAddressProvider {
    return typeof x === 'function';
}

function normalizeOptions(
    arg?: MacAddressProvider | ConnectSmartCubeOptions
): ConnectSmartCubeOptions {
    if (arg === undefined) {
        return {};
    }
    if (isMacAddressProvider(arg)) {
        return { macAddressProvider: arg };
    }
    return arg;
}

/**
 * True when the selected device could belong to a protocol that must learn its MAC address.
 * When every name-matching protocol leaves `needsMac` unset, the pre-connect advertisement
 * pass is pure latency and is skipped. An unrecognised name keeps the pass (conservative).
 */
function deviceMayNeedMac(protocols: SmartCubeProtocol[], device: BluetoothDevice): boolean {
    const matching = protocols.filter((p) => p.matchesDevice(device));
    if (matching.length === 0) {
        return true;
    }
    return matching.some((p) => p.needsMac === true);
}

function disconnectGattQuietly(device: BluetoothDevice): void {
    try {
        device.gatt?.disconnect();
    } catch {
        /* ignore */
    }
}

export async function connectSmartCube(
    arg?: MacAddressProvider | ConnectSmartCubeOptions
): Promise<SmartCubeConnection> {
    const opts = normalizeOptions(arg);
    const protocols = getRegisteredProtocols();
    // A throwing user status callback must never leave a connection dangling.
    const status = (message: string): void => {
        try {
            opts.onStatus?.(message);
        } catch {
            /* user callback errors are not connect failures */
        }
    };

    if (protocols.length === 0) {
        throw new Error('No smartcube protocols registered');
    }

    throwIfAborted(opts.signal);
    const mode: DeviceSelectionMode = opts.deviceSelection ?? 'filtered';
    const requestOptions = buildRequestDeviceOptions(protocols, mode, {
        deviceName: opts.deviceName,
    });
    status('Select your cube…');

    const device = await navigator.bluetooth.requestDevice(requestOptions);

    let conn: SmartCubeConnection;
    try {
        throwIfAborted(opts.signal);

        let advertisementManufacturerData: BluetoothManufacturerData | null = null;
        if (deviceMayNeedMac(protocols, device)) {
            status('Reading advertisements…');
            advertisementManufacturerData = await waitForManufacturerData(
                device,
                opts.enableAddressSearch ? ADVERTISEMENT_SEARCH_WAIT_MS : ADVERTISEMENT_WAIT_MS,
                { signal: opts.signal }
            );
            throwIfAborted(opts.signal);
        }

        status('Connecting…');
        const serviceUuids = await collectPrimaryServiceUuids(device, { signal: opts.signal });

        const protocol = resolveProtocolByGatt(protocols, serviceUuids, device);
        if (!protocol) {
            throw new Error("Selected device doesn't match any registered smartcube protocol");
        }
        throwIfAborted(opts.signal);

        const context = {
            serviceUuids,
            advertisementManufacturerData,
            enableAddressSearch: opts.enableAddressSearch === true,
            onStatus: opts.onStatus,
            signal: opts.signal,
        };

        conn = await protocol.connect(device, opts.macAddressProvider, context);
    } catch (e) {
        disconnectGattQuietly(device);
        throw e;
    }
    if (opts.signal?.aborted) {
        // The abort raced connection completion: tear the connection down properly.
        await conn.disconnect().catch(() => disconnectGattQuietly(device));
        throw abortError();
    }
    if (conn.deviceMAC) {
        status('Verifying connection…');
        try {
            let commandError: unknown = null;
            const verifyPromise = waitForVerifiedCubeEvent(
                conn,
                MAC_VERIFY_TIMEOUT_MS,
                opts.signal,
                macProofPredicate(conn)
            );
            requestFreshStateForMacVerify(conn, (e) => {
                commandError = e;
            });
            try {
                await verifyPromise;
            } catch (e) {
                if (e instanceof TimeoutError && commandError) {
                    // The refresh command failed outright; surface that instead of a
                    // misleading "no data" timeout.
                    throw commandError;
                }
                throw e;
            }
        } catch (e) {
            const aborted = isAbortError(e);
            if (!aborted) {
                removeCachedMacForDevice(device);
            }
            // Tear down through the connection so notifications, listeners, and timers
            // are cleaned up; fall back to raw GATT only if that fails.
            await conn.disconnect().catch(() => disconnectGattQuietly(device));
            if (aborted) {
                throw e;
            }
            if (e instanceof TimeoutError) {
                throw new Error(
                    'Timed out waiting for cube data. Check the Bluetooth MAC address and try again.'
                );
            }
            throw e;
        }
        setCachedMacForDevice(device, conn.deviceMAC);
    }
    return conn;
}
