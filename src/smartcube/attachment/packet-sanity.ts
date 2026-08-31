/**
 * Post-decrypt sanity checks for MAC candidate probing.
 */

/** Validates a decrypted MoYu32 notification bitstream. */
export function isValidMoYu32DecryptedPacket(bytes: number[]): boolean {
    if (!bytes || bytes.length < 20) {
        return false;
    }
    try {
        for (let i = 0; i < bytes.length; i++) {
            if (bytes[i]! < 0 || bytes[i]! > 255) {
                return false;
            }
        }
        let zeroCount = 0;
        let ffCount = 0;
        for (let i = 0; i < Math.min(bytes.length, 20); i++) {
            if (bytes[i] === 0) {
                zeroCount++;
            } else if (bytes[i] === 255) {
                ffCount++;
            }
        }
        // A wrong-key decrypt looks like noise: nearly-constant or nearly-uniform bytes.
        if (zeroCount > 14 || ffCount > 14 || new Set(bytes.slice(0, 20)).size > 18) {
            return false;
        }
        let bits = '';
        for (let i = 0; i < bytes.length; i++) {
            bits += (bytes[i]! + 256).toString(2).slice(1);
        }
        const opcode = parseInt(bits.slice(0, 8), 2);
        return validateMoYu32BitBody(bits, opcode);
    } catch {
        return false;
    }
}

function validateMoYu32BitBody(bits: string, expectedOpcode: number): boolean {
    if (!bits || bits.length < 160) {
        return false;
    }
    try {
        const opcode = parseInt(bits.slice(0, 8), 2);
        if (
            opcode !== expectedOpcode ||
            ![161, 163, 164, 165, 171].includes(opcode) ||
            (opcode === 164 && parseInt(bits.slice(8, 16), 2) > 100)
        ) {
            return false;
        }
        if (opcode === 161) {
            // Hardware info: eight bytes of printable-ASCII (or NUL) device name.
            for (let i = 0; i < 8; i++) {
                const charCode = parseInt(bits.slice(8 + 8 * i, 16 + 8 * i), 2);
                if (charCode !== 0 && (charCode < 32 || charCode > 126)) {
                    return false;
                }
            }
        }
        if (opcode === 165) {
            // Move packet: 5-bit move codes must be valid (or the 31 filler), with plausible timestamps.
            let validMoveCount = 0;
            for (let i = 0; i < 5; i++) {
                const moveCode = parseInt(bits.slice(96 + 5 * i, 101 + 5 * i), 2);
                if (moveCode <= 11) {
                    validMoveCount++;
                } else if (moveCode < 31) {
                    return false;
                }
            }
            if (validMoveCount === 0) {
                return false;
            }
            let allZero = true;
            let allMax = true;
            for (let i = 0; i < validMoveCount; i++) {
                const timeOffset = parseInt(bits.slice(8 + 16 * i, 24 + 16 * i), 2);
                if (timeOffset !== 0) {
                    allZero = false;
                }
                if (timeOffset !== 65535) {
                    allMax = false;
                }
            }
            if (allZero || allMax) {
                return false;
            }
        }
        if (opcode === 163) {
            // Facelets: the 144-bit sticker body of a real cube is never almost-constant.
            const body = bits.slice(8, 152);
            const zeros = (body.match(/0/g) || []).length;
            const ones = (body.match(/1/g) || []).length;
            if (zeros > 0.9 * body.length || ones > 0.9 * body.length) {
                return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

/** Validates a decrypted QiYi notification payload. */
export function isValidQiYiDecryptedPacket(payload: Uint8Array): boolean {
    if (!payload || payload.length < 7) {
        return false;
    }
    try {
        const header = payload[0]!;
        if (header === 254) {
            const command = payload[1]!;
            const subType = payload[2]!;
            if (![2, 3].includes(subType) || command < 7 || command > 100) {
                return false;
            }
            const deviceTimestamp =
                ((payload[3]! << 24) | (payload[4]! << 16) | (payload[5]! << 8) | payload[6]!) >>> 0;
            if (deviceTimestamp === 0 || deviceTimestamp === 0xffffffff) {
                return false;
            }
            return true;
        }
        if (header === 204 && payload[1] === 16) {
            // Quaternion packet: components are milli-units of a unit quaternion, so |q| <= ~1000.
            if (payload.length < 16) {
                return false;
            }
            const dv = new DataView(payload.buffer, payload.byteOffset);
            const qx = dv.getInt16(6, false);
            const qy = dv.getInt16(8, false);
            const qz = dv.getInt16(10, false);
            const qw = dv.getInt16(12, false);
            if (Math.abs(qx) > 2000 || Math.abs(qy) > 2000 || Math.abs(qz) > 2000 || Math.abs(qw) > 2000) {
                return false;
            }
            return true;
        }
        return false;
    } catch {
        return false;
    }
}
