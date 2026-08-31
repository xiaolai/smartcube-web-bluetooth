import { describe, it, expect, afterEach } from 'vitest';
import { resolveBluetooth } from '../../bluetooth-source';

/**
 * The library must be usable where `navigator.bluetooth` does not exist.
 *
 * That is not an edge case, it is most of the world outside a browser tab: WKWebView on macOS and
 * iOS, Android WebView, WebView2 and WebKitGTK all ship without Web Bluetooth, so a host that can
 * reach the radio natively still had no way to hand that capability in. The only workaround was to
 * assign to `navigator.bluetooth` from outside — a global mutation performed on a library that
 * never asked for one, and one that cannot be scoped to a single connection.
 */
describe('resolveBluetooth', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  });

  const setNavigator = (value: unknown) =>
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });

  it('prefers an injected implementation over the global one', () => {
    // Precedence matters: a caller that passes an adapter has a reason, and silently preferring
    // the browser's would send the connection somewhere the caller did not choose.
    const injected = { requestDevice: async () => ({}) as BluetoothDevice };
    setNavigator({ bluetooth: { requestDevice: async () => ({}) as BluetoothDevice } });
    expect(resolveBluetooth(injected)).toBe(injected);
  });

  it('falls back to navigator.bluetooth when nothing is injected', () => {
    const globalBt = { requestDevice: async () => ({}) as BluetoothDevice };
    setNavigator({ bluetooth: globalBt });
    expect(resolveBluetooth()).toBe(globalBt);
  });

  it('explains itself when there is neither, instead of throwing on undefined', () => {
    // The old failure was `Cannot read properties of undefined (reading 'requestDevice')`, which
    // reads like a library bug rather than a capability the caller is able to supply.
    setNavigator({});
    expect(() => resolveBluetooth()).toThrow(/No Web Bluetooth available/);
    expect(() => resolveBluetooth()).toThrow(/pass one as the `bluetooth` option/);
  });

  it('works with no navigator at all — a bare Node or worker context', () => {
    delete (globalThis as { navigator?: unknown }).navigator;
    expect(() => resolveBluetooth()).toThrow(/No Web Bluetooth available/);
    const injected = { requestDevice: async () => ({}) as BluetoothDevice };
    expect(resolveBluetooth(injected)).toBe(injected);
  });

  it('asks for requestDevice and nothing more', () => {
    // The surface an adapter must satisfy is the point of the whole change. If this ever needs a
    // second method, every existing adapter breaks — so the narrowness is worth pinning.
    const minimal = { requestDevice: async () => ({}) as BluetoothDevice };
    expect(Object.keys(minimal)).toEqual(['requestDevice']);
    expect(resolveBluetooth(minimal)).toBe(minimal);
  });
});
