/**
 * Where this library gets its Web Bluetooth entry point.
 *
 * It used to read `navigator.bluetooth` directly at three call sites, which quietly made a browser
 * a REQUIREMENT rather than a default. Every WebView that ships without Web Bluetooth — WKWebView
 * on macOS and iOS, Android WebView, WebView2, WebKitGTK — could not run this library at all, no
 * matter how capable its host was of reaching the radio. A Tauri or Electron app with native BLE
 * had no way in except to assign to `navigator.bluetooth` from outside, which is a global mutation
 * performed on a library that never asked for one.
 *
 * One body rather than three, deliberately: three copies of "the injected one, else the global,
 * else throw" is three chances for the fallback and the error message to drift apart.
 */

/**
 * The part of the Web Bluetooth entry point this library actually calls.
 *
 * `Pick<Bluetooth, 'requestDevice'>` rather than `Bluetooth`, because an implementation should have
 * to provide what is USED, not what the spec happens to define. Requiring `getAvailability` or
 * `getDevices` would exclude perfectly good adapters over methods no code path here touches — and
 * everything after `requestDevice` flows through the returned device, so the surface really is
 * this small.
 */
export type BluetoothLike = Pick<Bluetooth, 'requestDevice'>;

/** Options accepted by every entry point that has to find a Bluetooth implementation. */
export interface BluetoothSourceOptions {
    /** The Web Bluetooth implementation to use. Defaults to `navigator.bluetooth`. */
    bluetooth?: BluetoothLike;
}

/**
 * The injected implementation, or the browser's — and a clear refusal when there is neither.
 *
 * Without this, a host with no Web Bluetooth failed with `Cannot read properties of undefined
 * (reading 'requestDevice')`, which tells a caller nothing about what to do and reads like a
 * library bug rather than a missing capability the caller is able to supply.
 */
export function resolveBluetooth(injected?: BluetoothLike): BluetoothLike {
    if (injected) {
        return injected;
    }
    const fromGlobal = (globalThis as { navigator?: { bluetooth?: BluetoothLike } }).navigator?.bluetooth;
    if (fromGlobal) {
        return fromGlobal;
    }
    throw new Error(
        'No Web Bluetooth available. This environment has no navigator.bluetooth — pass one as the ' +
            '`bluetooth` option (any object with requestDevice) to run on a host that reaches the ' +
            'radio some other way.'
    );
}
