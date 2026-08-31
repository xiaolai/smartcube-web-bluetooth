/**
 * Structural checks on decrypted GAN gen2/3/4 payloads (after AES).
 */

import { GanBitReader } from './gan-bit-reader';

export { GanBitReader };

export function isValidGanGen2Packet(e: Uint8Array | number[]): boolean {
    if (!e || e.length < 16) return false;
    try {
        const t = new GanBitReader(e);
        const i = t.getBitWord(0, 4);
        if (![1, 2, 4, 5, 9, 13].includes(i)) return false;
        if (i === 1) {
            const a = t.getBitWord(4, 16);
            const b = t.getBitWord(20, 16);
            const c = t.getBitWord(36, 16);
            const d = t.getBitWord(52, 16);
            if (a === 0 && b === 0 && c === 0 && d === 0) return false;
        } else if (i === 2) {
            for (let j = 0; j < 7; j++) {
                const v = t.getBitWord(12 + 5 * j, 4);
                if (v > 5) return false;
            }
        } else if (i === 4) {
            let s = 0;
            for (let j = 0; j < 7; j++) s += t.getBitWord(12 + 3 * j, 3);
            if (s > 28) return false;
            let x = 0;
            for (let j = 0; j < 11; j++) x += t.getBitWord(47 + 4 * j, 4);
            if (x > 66) return false;
            // The cube transmits 11 of 12 EOs; the 12th is reconstructed from the
            // EO parity invariant. The 11-bit window can sum to either parity, so
            // there is nothing to validate here without knowing the 12th bit.
        } else if (i === 9) {
            if (t.getBitWord(8, 8) > 100) return false;
        } else if (i === 5) {
            for (let j = 0; j < 8; j++) {
                const v = t.getBitWord(8 * j + 40, 8);
                if (v !== 0 && (v < 32 || v > 126)) return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

export function isValidGanGen3Packet(e: Uint8Array | number[]): boolean {
    if (!e || e.length < 16) return false;
    try {
        const t = new GanBitReader(e);
        const i = t.getBitWord(0, 8);
        const n = t.getBitWord(8, 8);
        const r = t.getBitWord(16, 8);
        if (i !== 85 || r === 0 || ![1, 2, 6, 7, 16, 17].includes(n)) return false;
        if (n === 1) {
            const f = t.getBitWord(74, 6);
            if ([2, 32, 8, 1, 16, 4].indexOf(f) < 0) return false;
        }
        return true;
    } catch {
        return false;
    }
}

export function isValidGanGen4Packet(e: Uint8Array | number[]): boolean {
    if (!e || e.length < 16) return false;
    try {
        const t = new GanBitReader(e);
        const i = t.getBitWord(0, 8);
        if (![1, 209, 237, 236, 239, 234, 250, 251, 252, 253, 254].includes(i)) return false;
        if (i === 1) {
            const f = t.getBitWord(66, 6);
            if ([2, 32, 8, 1, 16, 4].indexOf(f) < 0) return false;
        }
        return true;
    } catch {
        return false;
    }
}
