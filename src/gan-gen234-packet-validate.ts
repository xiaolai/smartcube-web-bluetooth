/**
 * Structural checks on decrypted GAN gen2/3/4 payloads (after AES).
 */

import { GanBitReader } from './gan-bit-reader';

export { GanBitReader };

export function isValidGanGen2Packet(payload: Uint8Array | number[]): boolean {
    if (!payload || payload.length < 16) return false;
    try {
        const msg = new GanBitReader(payload);
        const eventType = msg.getBitWord(0, 4);
        if (![1, 2, 4, 5, 9, 13].includes(eventType)) return false;
        if (eventType === 1) {
            // GYRO: an all-zero quaternion never occurs on a real cube.
            const qw = msg.getBitWord(4, 16);
            const qx = msg.getBitWord(20, 16);
            const qy = msg.getBitWord(36, 16);
            const qz = msg.getBitWord(52, 16);
            if (qw === 0 && qx === 0 && qy === 0 && qz === 0) return false;
        } else if (eventType === 2) {
            // MOVE: face indices are 0..5.
            for (let i = 0; i < 7; i++) {
                const face = msg.getBitWord(12 + 5 * i, 4);
                if (face > 5) return false;
            }
        } else if (eventType === 4) {
            // FACELETS: permutation sums are bounded by the untransmitted 8th corner / 12th edge.
            let cornerPermSum = 0;
            for (let i = 0; i < 7; i++) cornerPermSum += msg.getBitWord(12 + 3 * i, 3);
            if (cornerPermSum > 28) return false;
            let edgePermSum = 0;
            for (let i = 0; i < 11; i++) edgePermSum += msg.getBitWord(47 + 4 * i, 4);
            if (edgePermSum > 66) return false;
            // The cube transmits 11 of 12 EOs; the 12th is reconstructed from the
            // EO parity invariant. The 11-bit window can sum to either parity, so
            // there is nothing to validate here without knowing the 12th bit.
        } else if (eventType === 9) {
            // BATTERY: percentage.
            if (msg.getBitWord(8, 8) > 100) return false;
        } else if (eventType === 5) {
            // HARDWARE: printable-ASCII (or NUL) device name.
            for (let i = 0; i < 8; i++) {
                const charCode = msg.getBitWord(8 * i + 40, 8);
                if (charCode !== 0 && (charCode < 32 || charCode > 126)) return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

export function isValidGanGen3Packet(payload: Uint8Array | number[]): boolean {
    if (!payload || payload.length < 16) return false;
    try {
        const msg = new GanBitReader(payload);
        const magic = msg.getBitWord(0, 8);
        const eventType = msg.getBitWord(8, 8);
        const dataLength = msg.getBitWord(16, 8);
        if (magic !== 85 || dataLength === 0 || ![1, 2, 6, 7, 16, 17].includes(eventType)) return false;
        if (eventType === 1) {
            // MOVE: the 6-bit face code is a one-hot value.
            const faceCode = msg.getBitWord(74, 6);
            if ([2, 32, 8, 1, 16, 4].indexOf(faceCode) < 0) return false;
        }
        return true;
    } catch {
        return false;
    }
}

export function isValidGanGen4Packet(payload: Uint8Array | number[]): boolean {
    if (!payload || payload.length < 16) return false;
    try {
        const msg = new GanBitReader(payload);
        const eventType = msg.getBitWord(0, 8);
        if (![1, 209, 237, 236, 239, 234, 250, 251, 252, 253, 254].includes(eventType)) return false;
        if (eventType === 1) {
            // MOVE: the 6-bit face code is a one-hot value.
            const faceCode = msg.getBitWord(66, 6);
            if ([2, 32, 8, 1, 16, 4].indexOf(faceCode) < 0) return false;
        }
        return true;
    } catch {
        return false;
    }
}
