import { describe, it, expect } from 'vitest';
import { deviceNameMatchesFilters } from '../../smartcube/protocol';

const device = (name?: string): BluetoothDevice => ({ name }) as BluetoothDevice;

describe('deviceNameMatchesFilters', () => {
  it('matches namePrefix filters', () => {
    const matches = deviceNameMatchesFilters([{ namePrefix: 'GAN' }, { namePrefix: 'AiCube' }]);
    expect(matches(device('GAN12ui'))).toBe(true);
    expect(matches(device('AiCube-X'))).toBe(true);
    expect(matches(device('QY-QYSC-S-A0E6'))).toBe(false);
    expect(matches(device(undefined))).toBe(false);
  });

  it('matches exact-name filters only exactly', () => {
    const matches = deviceNameMatchesFilters([{ name: 'GANicXXX' }]);
    expect(matches(device('GANicXXX'))).toBe(true);
    expect(matches(device('GANicXXX2'))).toBe(false);
  });
});
