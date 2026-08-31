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

const MAC_VERIFY_TIMEOUT_MS = 10_000;

/**
 * After we subscribe for MAC proof, ask the cube for a fresh report. Init often emits
 * FACELETS before this subscription exists (Subject does not replay), so without this
 * we can time out even with a correct MAC. Fire-and-forget so a stuck write cannot
 * block verification or leave the UI on "Verifying…" indefinitely.
 */
function requestFreshStateForMacVerify(conn: SmartCubeConnection): void {
    const c = conn.capabilities;
    const p: Promise<void> = c.facelets
        ? conn.sendCommand({ type: 'REQUEST_FACELETS' })
        : c.hardware
          ? conn.sendCommand({ type: 'REQUEST_HARDWARE' })
          : c.battery
            ? conn.sendCommand({ type: 'REQUEST_BATTERY' })
            : Promise.resolve();
    p.catch(() => {});
}

/**
 * Wait until we see decrypted/valid cube traffic so we do not persist a wrong MAC
 * (GAN / MoYu32 / QiYi can complete GATT setup before crypto is proven).
 */
function waitForVerifiedCubeEvent(
    conn: SmartCubeConnection,
    timeoutMs: number,
    signal?: AbortSignal
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

        sub = conn.events$.pipe(filter(isMacCacheProofEvent), take(1)).subscribe({
            next: () => {
                finish(() => resolve());
            },
            error: (err: unknown) => {
                finish(() => reject(err));
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

export async function connectSmartCube(
    arg?: MacAddressProvider | ConnectSmartCubeOptions
): Promise<SmartCubeConnection> {
    const opts = normalizeOptions(arg);
    const protocols = getRegisteredProtocols();

    if (protocols.length === 0) {
        throw new Error('No smartcube protocols registered');
    }

    const mode: DeviceSelectionMode = opts.deviceSelection ?? 'filtered';
    const requestOptions = buildRequestDeviceOptions(protocols, mode, {
        deviceName: opts.deviceName,
    });
    opts.onStatus?.('Select your cube…');

    const device = await navigator.bluetooth.requestDevice(requestOptions);

    let conn: SmartCubeConnection;
    try {
        throwIfAborted(opts.signal);

        let advertisementManufacturerData: BluetoothManufacturerData | null = null;
        if (deviceMayNeedMac(protocols, device)) {
            opts.onStatus?.('Reading advertisements…');
            advertisementManufacturerData = await waitForManufacturerData(
                device,
                opts.enableAddressSearch ? 8000 : 2500,
                { signal: opts.signal }
            );
            throwIfAborted(opts.signal);
        }

        opts.onStatus?.('Connecting…');
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
        try {
            device.gatt?.disconnect();
        } catch {
            /* ignore */
        }
        throw e;
    }
    if (conn.deviceMAC) {
        opts.onStatus?.('Verifying connection…');
        try {
            const verifyPromise = waitForVerifiedCubeEvent(
                conn,
                MAC_VERIFY_TIMEOUT_MS,
                opts.signal
            );
            requestFreshStateForMacVerify(conn);
            await verifyPromise;
        } catch (e) {
            const aborted = isAbortError(e);
            if (!aborted) {
                removeCachedMacForDevice(device);
            }
            try {
                device.gatt?.disconnect();
            } catch {
                /* ignore */
            }
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
