import { describe, it, expect } from 'vitest';
import { extractMacFromManufacturerData } from './ble-utils';

describe('extractMacFromManufacturerData', () => {
  it('returns null when manufacturer data is null', () => {
    expect(extractMacFromManufacturerData(null, [1, 2, 3])).toBeNull();
  });

  it('returns null when manufacturer data is shorter than 6 bytes', () => {
    const dv = new DataView(new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]).buffer);
    expect(extractMacFromManufacturerData(dv, [], true)).toBeNull();
  });

  it('returns reversed-order MAC when input is a DataView', () => {
    const dv = new DataView(
      // first 2 bytes are ignored by extractMacFromManufacturerData when given a DataView
      new Uint8Array([0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]).buffer
    );

    expect(extractMacFromManufacturerData(dv, [], true)).toBe('66:55:44:33:22:11');
  });

  it('returns forward-order MAC when reversedByteOrder is false', () => {
    const dv = new DataView(
      // first 2 bytes are ignored by extractMacFromManufacturerData when given a DataView
      new Uint8Array([0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]).buffer
    );

    expect(extractMacFromManufacturerData(dv, [], false)).toBe('11:22:33:44:55:66');
  });

  it('distinguishes reversedByteOrder modes for DataView payloads longer than 6 bytes (head vs tail)', () => {
    // When mfData is a DataView, extractMacFromManufacturerData slices off the first 2 bytes,
    // then either reads bytes 0..5 reversed (reversedByteOrder=true) or reads the *last* 6
    // bytes in forward order (reversedByteOrder=false).
    const dv = new DataView(
      new Uint8Array([
        0x00,
        0x00, // ignored
        0x11,
        0x22,
        0x33,
        0x44,
        0x55,
        0x66, // head MAC bytes (post-slice)
        0xaa,
        0xbb,
        0xcc,
        0xdd,
        0xee,
        0xff, // tail MAC bytes (post-slice)
      ]).buffer
    );

    expect(extractMacFromManufacturerData(dv, [], true)).toBe('66:55:44:33:22:11');
    expect(extractMacFromManufacturerData(dv, [], false)).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('reads the correct bytes when the DataView is a subview of a larger buffer', () => {
    // The MAC bytes preceded by unrelated bytes in the same backing buffer: slicing
    // from buffer offset 0 (the old behavior) would read the 0xde/0xad garbage instead.
    const backing = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    const sub = new DataView(backing.buffer, 4, 8); // [0x00,0x00,0x11..0x66]
    expect(extractMacFromManufacturerData(sub, [], true)).toBe('66:55:44:33:22:11');
  });

  it('selects manufacturerData by company id list when input is a BluetoothManufacturerData map', () => {
    const mf = new Map<number, DataView>();
    mf.set(1, new DataView(new Uint8Array([0x99, 0x88, 0x77, 0x66, 0x55, 0x44]).buffer));
    mf.set(2, new DataView(new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]).buffer));

    // Picks id=2 and reverses the first 6 bytes of its DataView.
    expect(extractMacFromManufacturerData(mf as unknown as BluetoothManufacturerData, [2, 1], true)).toBe('66:55:44:33:22:11');
  });

  it('skips a company-id entry whose payload is too short instead of failing on it', () => {
    const mf = new Map<number, DataView>();
    mf.set(2, new DataView(new Uint8Array([0x11, 0x22]).buffer)); // present but unusable
    mf.set(1, new DataView(new Uint8Array([0x99, 0x88, 0x77, 0x66, 0x55, 0x44]).buffer));

    expect(extractMacFromManufacturerData(mf as unknown as BluetoothManufacturerData, [2, 1], true)).toBe('44:55:66:77:88:99');
  });
});
