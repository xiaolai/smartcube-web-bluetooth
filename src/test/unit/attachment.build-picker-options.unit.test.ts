import { describe, it, expect } from 'vitest';
import { buildRequestDeviceOptions } from '../../smartcube/attachment/build-picker-options';
import { DEFAULT_SMARTCUBE_OPTIONAL_SERVICES } from '../../smartcube/attachment/default-optional-services';
import type { SmartCubeProtocol } from '../../smartcube/protocol';

function protocol(over: Partial<SmartCubeProtocol>): SmartCubeProtocol {
  return {
    nameFilters: [],
    optionalServices: [],
    matchesDevice: () => false,
    gattAffinity: () => 0,
    connect: async () => {
      throw new Error('not connectable');
    },
    ...over,
  };
}

const GAN = protocol({
  nameFilters: [{ namePrefix: 'GAN' }, { namePrefix: 'MG' }],
  optionalServices: ['6e400001-b5a3-f393-e0a9-e50e24dc4179'],
  optionalManufacturerData: [0x0201, 0x0101],
});
const QIYI = protocol({
  nameFilters: [{ namePrefix: 'QY-QYSC' }],
  optionalServices: ['0000fff0-0000-1000-8000-00805f9b34fb'],
  optionalManufacturerData: [0x0504, 0x0101],
});
const GIIKER = protocol({
  nameFilters: [{ name: 'Mi Smart Magic Cube' }],
  optionalServices: ['0000aadb-0000-1000-8000-00805f9b34fb', '0000aaaa-0000-1000-8000-00805f9b34fb'],
});

describe('buildRequestDeviceOptions', () => {
  describe('filtered mode (the default picker)', () => {
    it('ORs every protocol name filter with one manufacturer-data filter per company id, ids de-duplicated and sorted', () => {
      const opts = buildRequestDeviceOptions([GAN, QIYI, GIIKER], 'filtered');
      expect('acceptAllDevices' in opts).toBe(false);
      expect((opts as RequestDeviceOptions & { filters: BluetoothLEScanFilter[] }).filters).toEqual([
        { namePrefix: 'GAN' },
        { namePrefix: 'MG' },
        { namePrefix: 'QY-QYSC' },
        { name: 'Mi Smart Magic Cube' },
        { manufacturerData: [{ companyIdentifier: 0x0101 }] },
        { manufacturerData: [{ companyIdentifier: 0x0201 }] },
        { manufacturerData: [{ companyIdentifier: 0x0504 }] },
      ]);
    });

    it('grants the defaults plus every protocol service, each once', () => {
      const opts = buildRequestDeviceOptions([GAN, QIYI, GIIKER, QIYI], 'filtered');
      const services = opts.optionalServices!;
      expect(new Set(services).size).toBe(services.length);
      for (const s of [...DEFAULT_SMARTCUBE_OPTIONAL_SERVICES, ...GAN.optionalServices, ...QIYI.optionalServices, ...GIIKER.optionalServices]) {
        expect(services).toContain(s);
      }
    });

    it('requests the same company ids as optionalManufacturerData so watchAdvertisements can expose them', () => {
      const opts = buildRequestDeviceOptions([GAN, QIYI], 'filtered');
      expect(opts.optionalManufacturerData).toEqual([0x0101, 0x0201, 0x0504]);
    });

    it('omits optionalManufacturerData and manufacturer filters when no protocol declares company ids', () => {
      const opts = buildRequestDeviceOptions([GIIKER], 'filtered');
      expect(opts.optionalManufacturerData).toBeUndefined();
      expect((opts as RequestDeviceOptions & { filters: BluetoothLEScanFilter[] }).filters).toEqual([{ name: 'Mi Smart Magic Cube' }]);
    });

    it('adds the exact-name and alias filters for a known device name, after the protocol filters', () => {
      const opts = buildRequestDeviceOptions([GIIKER], 'filtered', { deviceName: 'GANic123' });
      expect((opts as RequestDeviceOptions & { filters: BluetoothLEScanFilter[] }).filters).toEqual([
        { name: 'Mi Smart Magic Cube' },
        { name: 'GANic123' },
        { name: 'GANicXXX' },
      ]);
    });
  });

  describe('any mode', () => {
    it('accepts all devices with no filters and still grants services and company ids', () => {
      const opts = buildRequestDeviceOptions([GAN, QIYI], 'any', { deviceName: 'GANic123' });
      expect(opts).toEqual({
        acceptAllDevices: true,
        optionalServices: expect.arrayContaining([...DEFAULT_SMARTCUBE_OPTIONAL_SERVICES, ...GAN.optionalServices, ...QIYI.optionalServices]),
        optionalManufacturerData: [0x0101, 0x0201, 0x0504],
      });
      expect('filters' in opts).toBe(false);
    });
  });
});
