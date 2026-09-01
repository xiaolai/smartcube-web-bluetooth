import type { FixtureSession } from '../fixtures';
import type { AttachmentContext } from '../../smartcube/attachment/types';

export function serviceUuidsFromFixture(fixture: FixtureSession): ReadonlySet<string> {
  return new Set(
    fixture.traffic
      .filter((e) => e.op === 'discover-service')
      .map((e) => e.service)
  );
}

/**
 * The AttachmentContext `connectSmartCube` hands a driver, for tests that call `protocol.connect`
 * directly: the given services, no advertisement data, no address search, no status/abort hooks.
 */
export function attachmentContextFor(
  serviceUuids: ReadonlySet<string>,
  overrides: Partial<AttachmentContext> = {}
): AttachmentContext {
  return {
    serviceUuids,
    advertisementManufacturerData: null,
    enableAddressSearch: false,
    onStatus: undefined,
    signal: undefined,
    ...overrides,
  };
}
