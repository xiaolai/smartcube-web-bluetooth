import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveCubeMac, type ResolveCubeMacOptions } from '../../smartcube/attachment/resolve-mac';
import { getCachedMacForDevice, setCachedMacForDevice } from '../../smartcube/attachment/address-hints';
import { isAbortError } from '../../smartcube/attachment/abort';
import { attachmentContextFor } from '../helpers/fixture-replay';

const MAC_A = 'CF:30:16:00:1A:2B';
const MAC_B = 'CF:30:16:01:1A:2B';
const MAC_C = 'CF:30:16:02:1A:2B';
const ADVERTISED = 'AA:BB:CC:DD:EE:FF';

/** A device with no watchAdvertisements: the fresh-advertisement rung resolves null at once. */
function device(name = 'WCU_MY32_1A2B', id = 'resolve-mac-device'): BluetoothDevice {
  return { id, name } as unknown as BluetoothDevice;
}

/** Parses manufacturer data only when it carries the sentinel company id. */
function options(over: Partial<ResolveCubeMacOptions> = {}): ResolveCubeMacOptions {
  return {
    parseFromManufacturerData: (mf) => (mf && !(mf instanceof DataView) && mf.has(0x0504) ? ADVERTISED : null),
    advertisementTimeoutsMs: [10, 20],
    candidatesFromName: () => [MAC_A, MAC_B, MAC_C],
    ...over,
  };
}

const adv = new Map([[0x0504, new DataView(new ArrayBuffer(8))]]);

describe('resolveCubeMac', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('takes the MAC from the advertisement context first and never consults the provider', async () => {
    const provider = vi.fn(async () => 'FF:FF:FF:FF:FF:FF');
    const mac = await resolveCubeMac(device(), provider, attachmentContextFor(new Set(), { advertisementManufacturerData: adv }), options());
    expect(mac).toBe(ADVERTISED);
    expect(provider).not.toHaveBeenCalled();
  });

  it('uses a valid cached MAC before asking the provider', async () => {
    const d = device();
    setCachedMacForDevice(d, MAC_B);
    const provider = vi.fn(async () => 'FF:FF:FF:FF:FF:FF');
    await expect(resolveCubeMac(d, provider, attachmentContextFor(new Set()), options())).resolves.toBe(MAC_B);
    expect(provider).not.toHaveBeenCalled();
  });

  it('drops a malformed cached MAC instead of handing it to key derivation, then continues the ladder', async () => {
    const d = device();
    setCachedMacForDevice(d, 'not-a-mac');
    const provider = vi.fn(async () => MAC_A);
    await expect(resolveCubeMac(d, provider, attachmentContextFor(new Set()), options())).resolves.toBe(MAC_A);
    expect(getCachedMacForDevice(d)).toBeNull();
    expect(provider).toHaveBeenCalledWith(d, false);
  });

  it('accepts the provider answer on the first, non-fallback call', async () => {
    const provider = vi.fn(async (_d: BluetoothDevice, fallback?: boolean) => (fallback ? MAC_C : MAC_A));
    await expect(resolveCubeMac(device(), provider, attachmentContextFor(new Set()), options())).resolves.toBe(MAC_A);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('uses a single unambiguous name candidate without probing when the driver allows it', async () => {
    const probe = vi.fn(async () => true);
    const mac = await resolveCubeMac(
      device('QY-QYSC-A-1A2B'),
      undefined,
      attachmentContextFor(new Set()),
      options({ candidatesFromName: () => ['CC:A2:00:00:1A:2B'], useSingleCandidateWithoutProbe: true, probe })
    );
    expect(mac).toBe('CC:A2:00:00:1A:2B');
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not probe name candidates unless the address search is enabled, and falls back to the provider', async () => {
    const probe = vi.fn(async () => true);
    const provider = vi.fn(async (_d: BluetoothDevice, fallback?: boolean) => (fallback ? MAC_C : null));
    const mac = await resolveCubeMac(device(), provider, attachmentContextFor(new Set(), { enableAddressSearch: false }), options({ probe }));
    expect(mac).toBe(MAC_C);
    expect(probe).not.toHaveBeenCalled();
    expect(provider).toHaveBeenNthCalledWith(2, expect.anything(), true);
  });

  describe('with the address search enabled', () => {
    it('probes candidates in name order, reports progress, and stops at the first that validates', async () => {
      const probe = vi.fn(async (_d: BluetoothDevice, mac: string, _o: { timeoutMs: number; signal?: AbortSignal }) => mac === MAC_B);
      const status: string[] = [];
      const mac = await resolveCubeMac(
        device(),
        undefined,
        attachmentContextFor(new Set(), { enableAddressSearch: true, onStatus: (m) => status.push(m) }),
        options({ probe, probeTimeoutMs: 123 })
      );
      expect(mac).toBe(MAC_B);
      expect(probe.mock.calls.map((c) => c[1])).toEqual([MAC_A, MAC_B]);
      expect(probe.mock.calls[0]![2]).toMatchObject({ timeoutMs: 123 });
      expect(status).toEqual(['Testing address (1/3)…', 'Testing address (2/3)…']);
    });

    it('treats a probe that throws as a failed candidate and tries the next one', async () => {
      const probe = vi.fn(async (_d: BluetoothDevice, mac: string) => {
        if (mac === MAC_A) throw new Error('GATT operation failed');
        return mac === MAC_C;
      });
      const mac = await resolveCubeMac(device(), undefined, attachmentContextFor(new Set(), { enableAddressSearch: true }), options({ probe }));
      expect(mac).toBe(MAC_C);
      expect(probe).toHaveBeenCalledTimes(3);
    });

    it('asks the provider as a last resort when every candidate fails', async () => {
      const probe = vi.fn(async () => false);
      const provider = vi.fn(async (_d: BluetoothDevice, fallback?: boolean) => (fallback ? MAC_C : null));
      const mac = await resolveCubeMac(device(), provider, attachmentContextFor(new Set(), { enableAddressSearch: true }), options({ probe }));
      expect(mac).toBe(MAC_C);
      expect(probe).toHaveBeenCalledTimes(3);
      expect(provider).toHaveBeenLastCalledWith(expect.anything(), true);
    });

    it('rethrows an abort raised inside a probe and does not fall through to the provider', async () => {
      const controller = new AbortController();
      const probe = vi.fn(async () => {
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      });
      const provider = vi.fn(async (_d: BluetoothDevice, fallback?: boolean) => (fallback ? MAC_C : null));
      const result = resolveCubeMac(
        device(),
        provider,
        attachmentContextFor(new Set(), { enableAddressSearch: true, signal: controller.signal }),
        options({ probe })
      );
      await result.then(
        () => {
          throw new Error('expected AbortError');
        },
        (e) => expect(isAbortError(e)).toBe(true)
      );
      expect(probe).toHaveBeenCalledTimes(1);
      expect(provider).toHaveBeenCalledTimes(1); // the first rung only; never the fallback
    });

    it('stops between candidates when the signal fires, before probing the next one', async () => {
      const controller = new AbortController();
      const probe = vi.fn(async () => {
        controller.abort(); // fires after this probe returns, before the next iteration
        return false;
      });
      const result = resolveCubeMac(device(), undefined, attachmentContextFor(new Set(), { enableAddressSearch: true, signal: controller.signal }), options({ probe }));
      await expect(result).rejects.toSatisfy(isAbortError);
      expect(probe).toHaveBeenCalledTimes(1);
    });
  });

  it('returns null when every rung is exhausted', async () => {
    const provider = vi.fn(async () => null);
    await expect(resolveCubeMac(device(), provider, attachmentContextFor(new Set()), options({ candidatesFromName: () => [] }))).resolves.toBeNull();
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = vi.fn(async () => MAC_A);
    await expect(resolveCubeMac(device(), provider, attachmentContextFor(new Set(), { signal: controller.signal }), options())).rejects.toSatisfy(isAbortError);
    expect(provider).not.toHaveBeenCalled();
  });
});
