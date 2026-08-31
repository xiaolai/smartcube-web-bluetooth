/**
 * Parse a Bluetooth MAC address string into its six octets in display order
 * (e.g. "CF:30:16:02:AF:9E" -> [0xCF, 0x30, 0x16, 0x02, 0xAF, 0x9E]).
 * Accepts ":", "-" or whitespace separators. Throws on anything that is not exactly six hex
 * octets, so a malformed address from a custom provider fails at connect time instead of
 * silently deriving a wrong AES key.
 */
export function parseMacBytes(mac: string): number[] {
    const parts = mac.trim().split(/[\s:-]+/).filter((p) => p.length > 0);
    const bytes = parts.map((p) => (/^[0-9a-fA-F]{1,2}$/.test(p) ? parseInt(p, 16) : NaN));
    if (bytes.length !== 6 || bytes.some((n) => Number.isNaN(n))) {
        throw new Error(`Invalid MAC address "${mac}": expected 6 hex octets like aa:bb:cc:dd:ee:ff`);
    }
    return bytes;
}
