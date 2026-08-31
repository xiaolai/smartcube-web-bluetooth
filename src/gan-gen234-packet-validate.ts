/**
 * Structural checks on decrypted GAN gen2/3/4 payloads (after AES).
 */

import { GanBitReader } from './gan-bit-reader';
import { decodeCornersEdges } from './gan-protocol-drivers';

export { GanBitReader };

/** One-hot face codes used by gen3/gen4 MOVE frames, in URFDLB order. */
const GAN_ONE_HOT_FACE_CODES: readonly number[] = [2, 32, 8, 1, 16, 4];

/**
 * Structural cube-state validation on a FACELETS payload: every corner/edge index in
 * range and unique. Orientation sums and permutation parity are deliberately not
 * enforced — a physically twisted corner is a state a real cube can report — but a
 * wrong-key decrypt virtually never survives the uniqueness requirement.
 */
function hasValidCornerEdgeState(
    msg: GanBitReader,
    offsets: { cp: number; co: number; ep: number; eo: number }
): boolean {
    const state = decodeCornersEdges(msg, offsets);
    const cpSeen = new Set(state.CP);
    if (cpSeen.size !== 8 || state.CP.some((v) => !Number.isInteger(v) || v < 0 || v > 7)) {
        return false;
    }
    if (state.CO.some((v) => !Number.isInteger(v) || v < 0 || v > 2)) {
        return false;
    }
    const epSeen = new Set(state.EP);
    if (epSeen.size !== 12 || state.EP.some((v) => !Number.isInteger(v) || v < 0 || v > 11)) {
        return false;
    }
    return true;
}

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
            // FACELETS: the decoded pieces must form a structurally valid cube state
            // (permutation-sum screens alone accepted e.g. the all-zero packet).
            if (!hasValidCornerEdgeState(msg, { cp: 12, co: 33, ep: 47, eo: 91 })) return false;
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
        // A forged length cannot claim more data than the frame carries (it bounds
        // downstream history loops).
        if (dataLength > payload.length) return false;
        if (eventType === 1) {
            // MOVE: the 6-bit face code is a one-hot value; direction is 0 (cw) or 1 (ccw).
            const faceCode = msg.getBitWord(74, 6);
            if (GAN_ONE_HOT_FACE_CODES.indexOf(faceCode) < 0) return false;
            if (msg.getBitWord(72, 2) > 1) return false;
        } else if (eventType === 2) {
            // FACELETS: structurally valid cube state required.
            if (!hasValidCornerEdgeState(msg, { cp: 40, co: 61, ep: 77, eo: 121 })) return false;
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
        const dataLength = msg.getBitWord(8, 8);
        // 251 (0xFB) was formerly accepted although no driver handles it.
        if (![1, 209, 237, 236, 239, 234, 250, 252, 253, 254].includes(eventType)) return false;
        if (dataLength > payload.length) return false;
        if (eventType === 1) {
            // MOVE: one notification can carry several 72-bit chunks; validate each
            // chunk's face code (one-hot) and direction (0/1), not only the first.
            const msgBitLength = payload.length * 8;
            let off = 0;
            let chunks = 0;
            while (off + 72 <= msgBitLength && msg.getBitWord(off, 8) === 1) {
                if (GAN_ONE_HOT_FACE_CODES.indexOf(msg.getBitWord(off + 66, 6)) < 0) return false;
                if (msg.getBitWord(off + 64, 2) > 1) return false;
                chunks++;
                off += 72;
            }
            if (chunks === 0) return false;
        } else if (eventType === 237) {
            // FACELETS: structurally valid cube state required.
            if (!hasValidCornerEdgeState(msg, { cp: 32, co: 53, ep: 69, eo: 113 })) return false;
        }
        return true;
    } catch {
        return false;
    }
}
