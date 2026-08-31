import { describe, it, expect } from 'vitest';
import { getRegisteredProtocols, registerProtocol, type SmartCubeProtocol } from '../../smartcube/protocol';

function dummy(): SmartCubeProtocol {
  return {
    nameFilters: [{ namePrefix: 'Dummy' }],
    optionalServices: [],
    matchesDevice: () => false,
    gattAffinity: () => 0,
    connect: async () => {
      throw new Error('not used');
    },
  };
}

describe('registerProtocol', () => {
  it('registers a protocol once even when called repeatedly with the same object', () => {
    const reg = getRegisteredProtocols();
    const before = [...reg];
    const p = dummy();
    try {
      registerProtocol(p);
      registerProtocol(p);
      registerProtocol(p);
      expect(reg.filter((x) => x === p)).toHaveLength(1);
    } finally {
      reg.length = 0;
      reg.push(...before);
    }
  });
});
