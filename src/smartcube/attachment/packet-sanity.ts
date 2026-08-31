/**
 * Post-decrypt sanity checks for MAC candidate probing.
 */

import { CubieCube } from '../cubie-cube';
import { crc16modbus } from './qiyi-wire';
import { parseMoyu32FaceletBits } from './moyu32-facelets';

const MOYU32_FRAME_SIZE = 20;
const OP_HARDWARE_INFO = 161;
const OP_FACELETS = 163;
const OP_BATTERY = 164;
const OP_MOVE = 165;
const OP_GYRO = 171;

/**
 * Validates a decrypted MoYu32 notification bitstream. MoYu32 keys derive from
 * the cube MAC, so a packet that decodes to a structurally valid frame is
 * strong evidence for the candidate.
 */
export function isValidMoYu32DecryptedPacket(bytes: number[]): boolean {
    if (!bytes || bytes.length !== MOYU32_FRAME_SIZE) {
        return false;
    }
    if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
        return false;
    }
    let bits = '';
    for (let i = 0; i < bytes.length; i++) {
        bits += (bytes[i]! + 256).toString(2).slice(1);
    }
    const opcode = parseInt(bits.slice(0, 8), 2);
    switch (opcode) {
        case OP_HARDWARE_INFO:
            return isValidMoyu32HardwareBody(bits);
        case OP_FACELETS:
            return isValidMoyu32FaceletsBody(bits);
        case OP_BATTERY:
            return isValidMoyu32BatteryBody(bytes);
        case OP_MOVE:
            return isValidMoyu32MoveBody(bits);
        case OP_GYRO:
            return isValidMoyu32GyroBody(bits);
        default:
            return false;
    }
}

/** Hardware info: eight bytes of printable-ASCII (or NUL) device name, not all NUL. */
function isValidMoyu32HardwareBody(bits: string): boolean {
    let printable = 0;
    for (let i = 0; i < 8; i++) {
        const charCode = parseInt(bits.slice(8 + 8 * i, 16 + 8 * i), 2);
        if (charCode !== 0 && (charCode < 32 || charCode > 126)) {
            return false;
        }
        if (charCode !== 0) {
            printable++;
        }
    }
    return printable > 0;
}

/** Facelets: the sticker body must decode to a structurally valid cube state. */
function isValidMoyu32FaceletsBody(bits: string): boolean {
    const facelet = parseMoyu32FaceletBits(bits.slice(8, 152));
    return new CubieCube().fromFacelet(facelet) !== -1;
}

/** Battery: a percentage byte followed by zero padding to the end of the frame. */
function isValidMoyu32BatteryBody(bytes: number[]): boolean {
    if (bytes[1]! > 100) {
        return false;
    }
    for (let i = 2; i < MOYU32_FRAME_SIZE; i++) {
        if (bytes[i] !== 0) {
            return false;
        }
    }
    return true;
}

/**
 * Move packet: five slots of 5-bit move codes (or the 31 filler); each valid
 * move's own timestamp slot must be plausible.
 */
function isValidMoyu32MoveBody(bits: string): boolean {
    let validMoveCount = 0;
    let allZero = true;
    let allMax = true;
    for (let i = 0; i < 5; i++) {
        const moveCode = parseInt(bits.slice(96 + 5 * i, 101 + 5 * i), 2);
        if (moveCode <= 11) {
            validMoveCount++;
            const timeOffset = parseInt(bits.slice(8 + 16 * i, 24 + 16 * i), 2);
            if (timeOffset !== 0) {
                allZero = false;
            }
            if (timeOffset !== 65535) {
                allMax = false;
            }
        } else if (moveCode < 31) {
            return false;
        }
    }
    if (validMoveCount === 0) {
        return false;
    }
    return !allZero && !allMax;
}

/** Gyro: no decodable invariant beyond the body not being almost-constant noise. */
function isValidMoyu32GyroBody(bits: string): boolean {
    const body = bits.slice(8, 152);
    const zeros = (body.match(/0/g) || []).length;
    return zeros < 0.9 * body.length && body.length - zeros < 0.9 * body.length;
}

/**
 * Validates a decrypted QiYi notification payload as proof for a MAC candidate.
 *
 * QiYi encrypts with a fixed public key, so ANY QiYi traffic decrypts correctly
 * regardless of the candidate — the only candidate-dependent exchange is the
 * hello handshake, which the cube answers (opcode 0x2) solely when the MAC in
 * our hello matched. State-change and quaternion packets must therefore never
 * count as evidence.
 */
export function isValidQiYiDecryptedPacket(payload: Uint8Array): boolean {
    if (!payload || payload.length < 7) {
        return false;
    }
    if (payload[0] !== 0xfe) {
        return false;
    }
    const frameLength = payload[1]!;
    if (frameLength < 7 || frameLength > payload.length) {
        return false;
    }
    const storedCrc = payload[frameLength - 2]! | (payload[frameLength - 1]! << 8);
    if (crc16modbus(payload.subarray(0, frameLength - 2)) !== storedCrc) {
        return false;
    }
    return payload[2] === 0x2; // hello response: the cube accepted our MAC
}
