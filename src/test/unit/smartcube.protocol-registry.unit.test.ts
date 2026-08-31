import { describe, it, expect } from 'vitest';
import {
  getRegisteredProtocols,
  registerProtocol,
  unregisterProtocol,
  type SmartCubeProtocol,
} from '../../smartcube/protocol';

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
    const p = dummy();
    try {
      registerProtocol(p);
      registerProtocol(p);
      registerProtocol(p);
      expect(getRegisteredProtocols().filter((x) => x === p)).toHaveLength(1);
    } finally {
      unregisterProtocol(p);
      expect(getRegisteredProtocols()).not.toContain(p);
    }
  });

  it('returns a snapshot: mutating the result does not affect the registry', () => {
    const p = dummy();
    try {
      registerProtocol(p);
      const snapshot = getRegisteredProtocols();
      snapshot.length = 0;
      expect(getRegisteredProtocols()).toContain(p);
    } finally {
      unregisterProtocol(p);
    }
  });

  it('freezes the registered descriptor and its filter arrays', () => {
    const p = dummy();
    try {
      registerProtocol(p);
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.isFrozen(p.nameFilters)).toBe(true);
      expect(Object.isFrozen(p.optionalServices)).toBe(true);
    } finally {
      unregisterProtocol(p);
    }
  });
});
