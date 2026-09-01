/**
 * GAN protocol drivers (gen2/gen3/gen4): binary event decoding, move-history recovery and
 * command encoding. The connection plumbing lives in gan-cube-protocol.ts.
 */

import { now, toKociembaFacelets } from './utils';
import { GanBitReader } from './gan-bit-reader';
import type {
    GanCubeCommand,
    GanCubeEvent,
    GanCubeRawConnection,
    GanCubeState,
    GanProtocolDriver,
} from './gan-cube-protocol';

/** Calculate sum of all numbers in array */
const sum: (arr: Array<number>) => number = arr => arr.reduce((a, v) => a + v, 0);

/** Live MOVE frames (gen3/gen4) carry the face as a one-hot 6-bit mask; the index is the URFDLB face. */
export const GAN_ONE_HOT_FACE_CODES: readonly number[] = [2, 32, 8, 1, 16, 4];
/** MOVE_HISTORY entries (gen3/gen4) carry the face as a 3-bit code; the index is the URFDLB face. */
const GAN_HISTORY_FACE_CODES: readonly number[] = [1, 5, 3, 0, 4, 2];

/** Standard notation from a URFDLB face index and direction bit (0 = CW, 1 = CCW): (1, 1) -> "R'". */
function moveNotation(face: number, direction: number): string {
    return ("URFDLB".charAt(face) + " '".charAt(direction)).trim();
}

/** ASCII field of `length` bytes starting at `bitOffset`. */
function asciiField(msg: GanBitReader, bitOffset: number, length: number): string {
    let text = '';
    for (let i = 0; i < length; i++) {
        text += String.fromCharCode(msg.getBitWord(bitOffset + i * 8, 8));
    }
    return text;
}

function batteryEvent(timestamp: number, level: number): GanCubeEvent {
    return { type: "BATTERY", timestamp, batteryLevel: Math.min(level, 100) };
}

function faceletsEvent(timestamp: number, serial: number, state: GanCubeState): GanCubeEvent {
    return {
        type: "FACELETS",
        serial,
        timestamp,
        facelets: toKociembaFacelets(state.CP, state.CO, state.EP, state.EO),
        state,
    };
}

/**
 * Decode 7 corners + 11 edges at the given bit offsets and reconstruct the 8th corner /
 * 12th edge from the permutation-sum and orientation-parity invariants.
 */
export function decodeCornersEdges(msg: GanBitReader, offsets: { cp: number; co: number; ep: number; eo: number }): GanCubeState {
    const cp: Array<number> = [];
    const co: Array<number> = [];
    const ep: Array<number> = [];
    const eo: Array<number> = [];
    for (let i = 0; i < 7; i++) {
        cp.push(msg.getBitWord(offsets.cp + i * 3, 3));
        co.push(msg.getBitWord(offsets.co + i * 2, 2));
    }
    cp.push(28 - sum(cp));
    co.push((3 - (sum(co) % 3)) % 3);
    for (let i = 0; i < 11; i++) {
        ep.push(msg.getBitWord(offsets.ep + i * 4, 4));
        eo.push(msg.getBitWord(offsets.eo + i, 1));
    }
    ep.push(66 - sum(ep));
    eo.push((2 - (sum(eo) % 2)) % 2);
    return { CP: cp, CO: co, EP: ep, EO: eo };
}

/** Quaternion (4 x 16-bit sign-magnitude) plus angular velocity (3 x 4-bit sign-magnitude). */
function decodeGyroEvent(msg: GanBitReader, timestamp: number, quaternionOffset: number, velocityOffset: number): GanCubeEvent {
    const qw = msg.getBitWord(quaternionOffset, 16);
    const qx = msg.getBitWord(quaternionOffset + 16, 16);
    const qy = msg.getBitWord(quaternionOffset + 32, 16);
    const qz = msg.getBitWord(quaternionOffset + 48, 16);
    const vx = msg.getBitWord(velocityOffset, 4);
    const vy = msg.getBitWord(velocityOffset + 4, 4);
    const vz = msg.getBitWord(velocityOffset + 8, 4);
    return {
        type: "GYRO",
        timestamp: timestamp,
        quaternion: {
            x: (1 - (qx >> 15) * 2) * (qx & 0x7FFF) / 0x7FFF,
            y: (1 - (qy >> 15) * 2) * (qy & 0x7FFF) / 0x7FFF,
            z: (1 - (qz >> 15) * 2) * (qz & 0x7FFF) / 0x7FFF,
            w: (1 - (qw >> 15) * 2) * (qw & 0x7FFF) / 0x7FFF
        },
        velocity: {
            x: (1 - (vx >> 3) * 2) * (vx & 0x7),
            y: (1 - (vy >> 3) * 2) * (vy & 0x7),
            z: (1 - (vz >> 3) * 2) * (vz & 0x7)
        }
    };
}

/**
 * Shared gen3/gen4 move bookkeeping: FIFO of pending moves, gap detection via circular
 * serials, history requests, and reverse-order injection of recovered moves.
 */
type BufferedMoveEvent = Extract<GanCubeEvent, { type: "MOVE" }>;

class GanMoveHistoryBuffer {

    /** Serial of the most recent state report received from the cube */
    serial: number = -1;
    /** Serial of the last move evicted to subscribers */
    lastSerial: number = -1;
    lastLocalTimestamp: number | null = null;
    private moveBuffer: BufferedMoveEvent[] = [];

    constructor(private readonly buildHistoryRequest: (serial: number, count: number) => Uint8Array) {}

    push(move: BufferedMoveEvent): void {
        this.moveBuffer.push(move);
    }

    /** Private cube command for requesting move history */
    private async requestMoveHistory(conn: GanCubeRawConnection, serial: number, count: number): Promise<void> {
        // Move history response data is byte-aligned, and moves always starting with near-ceil odd serial number, regardless of requested.
        // Adjust serial and count to get odd serial aligned history window with even number of moves inside.
        if (serial % 2 === 0)
            serial = (serial - 1) & 0xFF;
        if (count % 2 === 1)
            count++;
        // Never overflow requested history window beyond the serial number cycle edge 255 -> 0.
        // Because due to firmware bugs (e.g. iCarry2) the moves beyond the edge will be spoofed with 'D' (just zero bytes).
        count = Math.min(count, serial + 1);
        return conn.sendCommandMessage(this.buildHistoryRequest(serial, count)).catch(() => {
            // Safe to suppress GATT write errors: the request is retried on the next move
            // event (gap still present) and by every periodic facelets event via
            // checkIfMoveMissed, so a failed request cannot lose moves permanently.
        });
    }

    /**
     * Evict move events from FIFO buffer until missing move event detected
     * In case of missing move, and if connection is provided, submit request for move history to fill gap in buffer
     */
    async evictMoveBuffer(conn?: GanCubeRawConnection): Promise<Array<GanCubeEvent>> {
        const evictedEvents: GanCubeEvent[] = [];
        while (this.moveBuffer.length > 0) {
            const bufferHead = this.moveBuffer[0]!;
            const diff = this.lastSerial === -1 ? 1 : (bufferHead.serial - this.lastSerial) & 0xFF;
            if (diff === 0) {
                // Duplicate of an already-evicted serial (retransmitted live MOVE):
                // discard instead of emitting a phantom physical move.
                this.moveBuffer.shift();
            } else if (diff > 1) {
                if (conn) {
                    await this.requestMoveHistory(conn, bufferHead.serial, diff);
                }
                break;
            } else {
                evictedEvents.push(this.moveBuffer.shift()!);
                this.lastSerial = bufferHead.serial;
            }
        }
        // Probably something went wrong and buffer is no longer evicted, so forcibly disconnect the cube
        if (conn && this.moveBuffer.length > 16) {
            conn.disconnect().catch(() => { /* already disconnected */ });
        }
        return evictedEvents;
    }

    /**
     * Check if circular serial number (modulo 256) fits into (start,end) serial number range.
     * By default range is open, set closedStart / closedEnd to make it closed.
     */
    private isSerialInRange(start: number, end: number, serial: number, closedStart = false, closedEnd = false) {
        return ((end - start) & 0xFF) >= ((serial - start) & 0xFF)
            && (closedStart || ((start - serial) & 0xFF) > 0)
            && (closedEnd || ((end - serial) & 0xFF) > 0);
    }

    /** Used to inject missed moves to FIFO buffer */
    injectMissedMoveToBuffer(move: BufferedMoveEvent) {
        if (move.type === "MOVE") {
            if (this.moveBuffer.length > 0) {
                const bufferHead = this.moveBuffer[0]!;
                // Skip if move event with the same serial already in the buffer
                if (this.moveBuffer.some(e => e.type === "MOVE" && e.serial === move.serial))
                    return;
                // Skip if move serial does not fit in range between last evicted event and event on buffer head, i.e. event must be one of missed
                if (!this.isSerialInRange(this.lastSerial, bufferHead.serial, move.serial))
                    return;
                // Move history events should be injected in reverse order, so just put suitable event on buffer head
                if (move.serial === ((bufferHead.serial - 1) & 0xFF)) {
                    this.moveBuffer.unshift(move);
                }
            } else {
                // This case happens when lost move is recovered using periodic 
                // facelets state event, and being inserted into the empty buffer.
                if (this.isSerialInRange(this.lastSerial, this.serial, move.serial, false, true)) {
                    this.moveBuffer.unshift(move);
                }
            }
        }
    }

    /** Used in response to periodic facelets event to check if any moves missed */
    async checkIfMoveMissed(conn: GanCubeRawConnection) {
        const diff = (this.serial - this.lastSerial) & 0xFF;
        if (diff > 0) {
            // serial 0 is skipped to avoid an iCarry2 firmware bug (history across the
            // 255->0 edge is spoofed with zero bytes); the next facelets event, with a
            // nonzero serial, retries the recovery.
            if (this.serial !== 0) {
                const bufferHead = this.moveBuffer[0];
                const startSerial = bufferHead ? bufferHead.serial : (this.serial + 1) & 0xFF;
                await this.requestMoveHistory(conn, startSerial, diff + 1);
            }
        }
    }
}

/** Bit offsets that differ between the otherwise identical gen3 and gen4 frame formats. */
type GanGen34FrameLayout = {
    /** 16-bit serial in FACELETS frames. */
    faceletsSerial: number;
    /** Corner/edge fields in FACELETS frames. */
    faceletsState: { cp: number; co: number; ep: number; eo: number };
    /** 8-bit start serial in MOVE_HISTORY frames. */
    historySerial: number;
    /** First 4-bit (face code, direction) entry in MOVE_HISTORY frames. */
    historyMoves: number;
};

const GAN_GEN3_LAYOUT: GanGen34FrameLayout = {
    faceletsSerial: 24,
    faceletsState: { cp: 40, co: 61, ep: 77, eo: 121 },
    historySerial: 24,
    historyMoves: 32,
};

const GAN_GEN4_LAYOUT: GanGen34FrameLayout = {
    faceletsSerial: 16,
    faceletsState: { cp: 32, co: 53, ep: 69, eo: 113 },
    historySerial: 16,
    historyMoves: 24,
};

/**
 * MOVE_HISTORY response (gen3/gen4): inject the recovered moves into the FIFO — the cube lists
 * them newest serial first — then evict whatever is now contiguous.
 */
async function handleGen34MoveHistory(
    history: GanMoveHistoryBuffer,
    msg: GanBitReader,
    timestamp: number,
    dataLength: number,
    layout: GanGen34FrameLayout
): Promise<GanCubeEvent[]> {
    const startSerial = msg.getBitWord(layout.historySerial, 8);
    const count = (dataLength - 1) * 2;
    for (let i = 0; i < count; i++) {
        const face = GAN_HISTORY_FACE_CODES.indexOf(msg.getBitWord(layout.historyMoves + 4 * i, 3));
        const direction = msg.getBitWord(layout.historyMoves + 3 + 4 * i, 1);
        if (face >= 0) {
            history.injectMissedMoveToBuffer({
                type: "MOVE",
                serial: (startSerial - i) & 0xFF,
                timestamp: timestamp,
                localTimestamp: null, // Missed and recovered events has no meaningfull local timestamps
                cubeTimestamp: null,  // Cube hardware timestamp for missed move you should interpolate using cubeTimestampLinearFit
                face: face,
                direction: direction,
                move: moveNotation(face, direction)
            });
        }
    }
    return history.evictMoveBuffer();
}

/**
 * Periodic FACELETS frame (gen3/gen4): while the move stream is idle, use its serial to detect
 * and recover missed moves, then decode the state.
 */
async function handleGen34Facelets(
    history: GanMoveHistoryBuffer,
    conn: GanCubeRawConnection,
    msg: GanBitReader,
    timestamp: number,
    layout: GanGen34FrameLayout
): Promise<GanCubeEvent[]> {
    const serial = history.serial = msg.getBitWord(layout.faceletsSerial, 16, true) & 0xFF;

    // Also check and recovery missed moves using periodic facelets event sent by cube
    if (history.lastSerial !== -1) {
        // Debounce the facelet event if there are active cube moves
        // A null timestamp means no live move arrived at all - the stream is idle
        // and recovery must be allowed, not skipped forever.
        if (history.lastLocalTimestamp == null || (timestamp - history.lastLocalTimestamp) > 500) {
            await history.checkIfMoveMissed(conn);
        }
    }

    if (history.lastSerial === -1)
        history.lastSerial = serial;

    return [faceletsEvent(timestamp, serial, decodeCornersEdges(msg, layout.faceletsState))];
}

/**
 * Driver implementation for GAN Gen2 protocol, supported cubes:
 *  - GAN Mini ui FreePlay
 *  - GAN12 ui FreePlay
 *  - GAN12 ui
 *  - GAN356 i Carry S
 *  - GAN356 i Carry
 *  - GAN356 i 3
 *  - Monster Go 3Ai
 */
class GanGen2ProtocolDriver implements GanProtocolDriver {

    private lastSerial: number = -1;
    private lastMoveTimestamp: number = 0;
    private cubeTimestamp: number = 0;

    createCommandMessage(command: GanCubeCommand): Uint8Array | undefined {
        let msg: Uint8Array | undefined = new Uint8Array(20).fill(0);
        switch (command.type) {
            case 'REQUEST_FACELETS':
                msg[0] = 0x04;
                break;
            case 'REQUEST_HARDWARE':
                msg[0] = 0x05;
                break;
            case 'REQUEST_BATTERY':
                msg[0] = 0x09;
                break;
            case 'REQUEST_RESET':
                msg.set([0x0A, 0x05, 0x39, 0x77, 0x00, 0x00, 0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
                break;
            default:
                msg = undefined;
        }
        return msg;
    }

    async handleStateEvent(conn: GanCubeRawConnection, eventMessage: Uint8Array): Promise<GanCubeEvent[]> {

        const timestamp = now();

        const cubeEvents: GanCubeEvent[] = [];
        const msg = new GanBitReader(eventMessage);
        const eventType = msg.getBitWord(0, 4);

        if (eventType === 0x01) { // GYRO

            cubeEvents.push(decodeGyroEvent(msg, timestamp, 4, 68));

        } else if (eventType === 0x02) { // MOVE

            if (this.lastSerial !== -1) { // Accept move events only after first facelets state event received

                const serial = msg.getBitWord(4, 8);
                const diff = Math.min((serial - this.lastSerial) & 0xFF, 7);
                this.lastSerial = serial;

                if (diff > 0) {
                    for (let i = diff - 1; i >= 0; i--) {
                        const face = msg.getBitWord(12 + 5 * i, 4);
                        const direction = msg.getBitWord(16 + 5 * i, 1);
                        // SUPERSEDED: moveNotation().
                        // const move = "URFDLB".charAt(face) + " '".charAt(direction);
                        let elapsed = msg.getBitWord(47 + 16 * i, 16);
                        if (elapsed === 0) { // In case of 16-bit cube timestamp register overflow
                            // Only substitute the host-clock gap once a baseline exists;
                            // lastMoveTimestamp starts at 0 and epoch-sized gaps would
                            // wildly inflate cubeTimestamp.
                            elapsed = this.lastMoveTimestamp > 0 ? timestamp - this.lastMoveTimestamp : 0;
                        }
                        this.cubeTimestamp += elapsed;
                        cubeEvents.push({
                            type: "MOVE",
                            serial: (serial - i) & 0xFF,
                            timestamp: timestamp,
                            localTimestamp: i === 0 ? timestamp : null, // Missed and recovered events has no meaningfull local timestamps
                            cubeTimestamp: this.cubeTimestamp,
                            face: face,
                            direction: direction,
                            move: moveNotation(face, direction)
                        });
                    }
                    this.lastMoveTimestamp = timestamp;
                }
            }

        } else if (eventType === 0x04) { // FACELETS

            const serial = msg.getBitWord(4, 8);

            if (this.lastSerial === -1)
                this.lastSerial = serial;

            cubeEvents.push(faceletsEvent(timestamp, serial, decodeCornersEdges(msg, { cp: 12, co: 33, ep: 47, eo: 91 })));

        } else if (eventType === 0x05) { // HARDWARE

            const hwMajor = msg.getBitWord(8, 8);
            const hwMinor = msg.getBitWord(16, 8);
            const swMajor = msg.getBitWord(24, 8);
            const swMinor = msg.getBitWord(32, 8);
            const gyroSupported = msg.getBitWord(104, 1);

            const hardwareName = asciiField(msg, 40, 8);
            // SUPERSEDED: asciiField().
            // let hardwareName = '';
            // for (let i = 0; i < 8; i++) {
            //     hardwareName += String.fromCharCode(msg.getBitWord(i * 8 + 40, 8));
            // }

            cubeEvents.push({
                type: "HARDWARE",
                timestamp: timestamp,
                hardwareName: hardwareName,
                hardwareVersion: `${hwMajor}.${hwMinor}`,
                softwareVersion: `${swMajor}.${swMinor}`,
                gyroSupported: !!gyroSupported
            });

        } else if (eventType === 0x09) { // BATTERY

            cubeEvents.push(batteryEvent(timestamp, msg.getBitWord(8, 8)));

        } else if (eventType === 0x0D) { // DISCONNECT
            conn.disconnect().catch(() => { /* already disconnected */ });
        }

        return cubeEvents;

    }

}

/**
 * Driver implementation for GAN Gen3 protocol, supported cubes:
 *  - GAN356 i Carry 2
 */
class GanGen3ProtocolDriver implements GanProtocolDriver {

    private readonly history = new GanMoveHistoryBuffer((serial, count) => {
        const msg = new Uint8Array(16).fill(0);
        msg.set([0x68, 0x03, serial, 0, count, 0]);
        return msg;
    });

    createCommandMessage(command: GanCubeCommand): Uint8Array | undefined {
        let msg: Uint8Array | undefined = new Uint8Array(16).fill(0);
        switch (command.type) {
            case 'REQUEST_FACELETS':
                msg.set([0x68, 0x01]);
                break;
            case 'REQUEST_HARDWARE':
                msg.set([0x68, 0x04]);
                break;
            case 'REQUEST_BATTERY':
                msg.set([0x68, 0x07]);
                break;
            case 'REQUEST_RESET':
                msg.set([0x68, 0x05, 0x05, 0x39, 0x77, 0x00, 0x00, 0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0x00, 0x00, 0x00]);
                break;
            default:
                msg = undefined;
        }
        return msg;
    }

    async handleStateEvent(conn: GanCubeRawConnection, eventMessage: Uint8Array): Promise<GanCubeEvent[]> {

        const timestamp = now();

        let cubeEvents: GanCubeEvent[] = [];
        const msg = new GanBitReader(eventMessage);

        const magic = msg.getBitWord(0, 8);
        const eventType = msg.getBitWord(8, 8);
        const dataLength = msg.getBitWord(16, 8);

        if (magic === 0x55 && dataLength > 0) {

            if (eventType === 0x01) { // MOVE

                if (this.history.lastSerial !== -1) { // Accept move events only after first facelets state event received

                    this.history.lastLocalTimestamp = timestamp;
                    const cubeTimestamp = msg.getBitWord(24, 32, true);
                    // Mask to the 8-bit domain the history/recovery math operates in.
                    const serial = this.history.serial = msg.getBitWord(56, 16, true) & 0xFF;

                    const direction = msg.getBitWord(72, 2);
                    const face = GAN_ONE_HOT_FACE_CODES.indexOf(msg.getBitWord(74, 6));
                    // SUPERSEDED: moveNotation().
                    // const move = "URFDLB".charAt(face) + " '".charAt(direction);

                    // put move event into FIFO buffer
                    if (face >= 0) {
                        this.history.push({
                            type: "MOVE",
                            serial: serial,
                            timestamp: timestamp,
                            localTimestamp: timestamp,
                            cubeTimestamp: cubeTimestamp,
                            face: face,
                            direction: direction,
                            move: moveNotation(face, direction)
                        });
                    }

                    // evict move events from FIFO buffer
                    cubeEvents = await this.history.evictMoveBuffer(conn);

                }

            } else if (eventType === 0x06) { // MOVE_HISTORY

                cubeEvents = await handleGen34MoveHistory(this.history, msg, timestamp, dataLength, GAN_GEN3_LAYOUT);
                // SUPERSEDED: handleGen34MoveHistory() — identical to gen4 except for the bit offsets.
                // const startSerial = msg.getBitWord(24, 8);
                // const count = (dataLength - 1) * 2;
                //
                // // inject missed moves into FIFO buffer
                // for (let i = 0; i < count; i++) {
                // const face = [1, 5, 3, 0, 4, 2].indexOf(msg.getBitWord(32 + 4 * i, 3));
                // const direction = msg.getBitWord(35 + 4 * i, 1);
                // if (face >= 0) {
                // const move = "URFDLB".charAt(face) + " '".charAt(direction);
                // this.history.injectMissedMoveToBuffer({
                // type: "MOVE",
                // serial: (startSerial - i) & 0xFF,
                // timestamp: timestamp,
                // localTimestamp: null, // Missed and recovered events has no meaningfull local timestamps
                // cubeTimestamp: null,  // Cube hardware timestamp for missed move you should interpolate using cubeTimestampLinearFit
                // face: face,
                // direction: direction,
                // move: move.trim()
                // });
                // }
                // }
                //
                // // evict move events from FIFO buffer
                // cubeEvents = await this.history.evictMoveBuffer();

            } else if (eventType === 0x02) { // FACELETS

                cubeEvents = await handleGen34Facelets(this.history, conn, msg, timestamp, GAN_GEN3_LAYOUT);
                // SUPERSEDED: handleGen34Facelets() — identical to gen4 except for the bit offsets.
                // const serial = this.history.serial = msg.getBitWord(24, 16, true) & 0xFF;
                //
                // // Also check and recovery missed moves using periodic facelets event sent by cube
                // if (this.history.lastSerial !== -1) {
                // // Debounce the facelet event if there are active cube moves
                // // A null timestamp means no live move arrived at all - the stream is idle
                // // and recovery must be allowed, not skipped forever.
                // if (this.history.lastLocalTimestamp == null || (timestamp - this.history.lastLocalTimestamp) > 500) {
                // await this.history.checkIfMoveMissed(conn);
                // }
                // }
                //
                // if (this.history.lastSerial === -1)
                // this.history.lastSerial = serial;
                //
                // const state = decodeCornersEdges(msg, { cp: 40, co: 61, ep: 77, eo: 121 });
                //
                // cubeEvents.push({
                // type: "FACELETS",
                // serial: serial,
                // timestamp: timestamp,
                // facelets: toKociembaFacelets(state.CP, state.CO, state.EP, state.EO),
                // state: state,
                // });

            } else if (eventType === 0x07) { // HARDWARE

                const swMajor = msg.getBitWord(72, 4);
                const swMinor = msg.getBitWord(76, 4);
                const hwMajor = msg.getBitWord(80, 4);
                const hwMinor = msg.getBitWord(84, 4);

                const hardwareName = asciiField(msg, 32, 5);
                // SUPERSEDED: asciiField().
                // let hardwareName = '';
                // for (let i = 0; i < 5; i++) {
                //     hardwareName += String.fromCharCode(msg.getBitWord(i * 8 + 32, 8));
                // }

                cubeEvents.push({
                    type: "HARDWARE",
                    timestamp: timestamp,
                    hardwareName: hardwareName,
                    hardwareVersion: `${hwMajor}.${hwMinor}`,
                    softwareVersion: `${swMajor}.${swMinor}`,
                    gyroSupported: false
                });

            } else if (eventType === 0x10) { // BATTERY

                cubeEvents.push(batteryEvent(timestamp, msg.getBitWord(24, 8)));

            } else if (eventType === 0x11) { // DISCONNECT
                conn.disconnect().catch(() => { /* already disconnected */ });
            }

        }

        return cubeEvents;

    }

}

/**
 * Driver implementation for GAN Gen4 protocol, supported cubes:
 *  - GAN12 ui Maglev
 *  - GAN14 ui FreePlay
 */
class GanGen4ProtocolDriver implements GanProtocolDriver {

    private readonly history = new GanMoveHistoryBuffer((serial, count) => {
        const msg = new Uint8Array(20).fill(0);
        msg.set([0xD1, 0x04, serial, 0, count, 0]);
        return msg;
    });

    // Used to store partial result acquired from hardware info events
    private hwInfo: { [key: number]: string } = {};

    /** Set when we have seen at least one 0xEC GYRO packet this connection (not cleared on REQUEST_HARDWARE). */
    private gyroObserved: boolean = false;

    /** Set when a full HARDWARE snapshot was emitted for the current hwInfo assembly; reset when REQUEST_HARDWARE clears hwInfo. */
    private hardwareInfoEmitted: boolean = false;

    createCommandMessage(command: GanCubeCommand): Uint8Array | undefined {
        let msg: Uint8Array | undefined = new Uint8Array(20).fill(0);
        switch (command.type) {
            case 'REQUEST_FACELETS':
                msg.set([0xDD, 0x04, 0x00, 0xED, 0x00, 0x00]);
                break;
            case 'REQUEST_HARDWARE':
                // Re-arm emission but keep the assembled fields: encoding a command that
                // is never sent (or whose write fails) must not destroy valid state.
                this.hardwareInfoEmitted = false;
                msg.set([0xDF, 0x03, 0x00, 0x00, 0x00]);
                break;
            case 'REQUEST_BATTERY':
                msg.set([0xDD, 0x04, 0x00, 0xEF, 0x00, 0x00]);
                break;
            case 'REQUEST_RESET':
                msg.set([0xD2, 0x0D, 0x05, 0x39, 0x77, 0x00, 0x00, 0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0x00, 0x00, 0x00]);
                break;
            default:
                msg = undefined;
        }
        return msg;
    }

    private buildHardwareEvent(timestamp: number): GanCubeEvent {
        return {
            type: "HARDWARE",
            timestamp: timestamp,
            hardwareName: this.hwInfo[0xFC],
            hardwareVersion: this.hwInfo[0xFE],
            softwareVersion: this.hwInfo[0xFD],
            productDate: this.hwInfo[0xFA],
            gyroSupported: this.gyroObserved
        };
    }

    async handleStateEvent(conn: GanCubeRawConnection, eventMessage: Uint8Array): Promise<GanCubeEvent[]> {

        const timestamp = now();

        let cubeEvents: GanCubeEvent[] = [];
        const msg = new GanBitReader(eventMessage);

        const eventType = msg.getBitWord(0, 8);
        const dataLength = msg.getBitWord(8, 8);

        if (eventType === 0x01) { // MOVE

            if (this.history.lastSerial !== -1) { // Accept move events only after first facelets state event received

                // One BLE notification may contain multiple MOVE chunks (72 bits each). Only reading the first
                // chunk drops later face turns (common on slice moves) until MOVE_HISTORY catches up
                const msgBitLen = eventMessage.length * 8;
                let off = 0;
                while (off + 72 <= msgBitLen && msg.getBitWord(off, 8) === 0x01) {
                    const cubeTimestamp = msg.getBitWord(off + 16, 32, true);
                    const serial = msg.getBitWord(off + 48, 16, true) & 0xFF;
                    this.history.serial = serial;

                    const direction = msg.getBitWord(off + 64, 2);
                    const face = GAN_ONE_HOT_FACE_CODES.indexOf(msg.getBitWord(off + 66, 6));
                    // SUPERSEDED: moveNotation().
                    // const move = "URFDLB".charAt(face) + " '".charAt(direction);

                    if (face < 0) {
                        break;
                    }

                    this.history.push({
                        type: "MOVE",
                        serial: serial,
                        timestamp: timestamp,
                        localTimestamp: timestamp,
                        cubeTimestamp: cubeTimestamp,
                        face: face,
                        direction: direction,
                        move: moveNotation(face, direction)
                    });
                    this.history.lastLocalTimestamp = timestamp;
                    off += 72;
                }

                // evict move events from FIFO buffer
                cubeEvents = await this.history.evictMoveBuffer(conn);

            }

        } else if (eventType === 0xD1) { // MOVE_HISTORY

            cubeEvents = await handleGen34MoveHistory(this.history, msg, timestamp, dataLength, GAN_GEN4_LAYOUT);
            // SUPERSEDED: handleGen34MoveHistory() — identical to gen3 except for the bit offsets.
            // const startSerial = msg.getBitWord(16, 8);
            // const count = (dataLength - 1) * 2;
            //
            // // inject missed moves into FIFO buffer
            // for (let i = 0; i < count; i++) {
            // const face = [1, 5, 3, 0, 4, 2].indexOf(msg.getBitWord(24 + 4 * i, 3));
            // const direction = msg.getBitWord(27 + 4 * i, 1);
            // if (face >= 0) {
            // const move = "URFDLB".charAt(face) + " '".charAt(direction);
            // this.history.injectMissedMoveToBuffer({
            // type: "MOVE",
            // serial: (startSerial - i) & 0xFF,
            // timestamp: timestamp,
            // localTimestamp: null, // Missed and recovered events has no meaningfull local timestamps
            // cubeTimestamp: null,  // Cube hardware timestamp for missed move you should interpolate using cubeTimestampLinearFit
            // face: face,
            // direction: direction,
            // move: move.trim()
            // });
            // }
            // }
            //
            // // evict move events from FIFO buffer
            // cubeEvents = await this.history.evictMoveBuffer();

        } else if (eventType === 0xED) { // FACELETS

            cubeEvents = await handleGen34Facelets(this.history, conn, msg, timestamp, GAN_GEN4_LAYOUT);
            // SUPERSEDED: handleGen34Facelets() — identical to gen3 except for the bit offsets.
            // const serial = this.history.serial = msg.getBitWord(16, 16, true) & 0xFF;
            //
            // // Also check and recovery missed moves using periodic facelets event sent by cube
            // if (this.history.lastSerial !== -1) {
            // // Debounce the facelet event if there are active cube moves
            // // A null timestamp means no live move arrived at all - the stream is idle
            // // and recovery must be allowed, not skipped forever.
            // if (this.history.lastLocalTimestamp == null || (timestamp - this.history.lastLocalTimestamp) > 500) {
            // await this.history.checkIfMoveMissed(conn);
            // }
            // }
            //
            // if (this.history.lastSerial === -1)
            // this.history.lastSerial = serial;
            //
            // const state = decodeCornersEdges(msg, { cp: 32, co: 53, ep: 69, eo: 113 });
            //
            // cubeEvents.push({
            // type: "FACELETS",
            // serial: serial,
            // timestamp: timestamp,
            // facelets: toKociembaFacelets(state.CP, state.CO, state.EP, state.EO),
            // state: state,
            // });

        } else if (eventType >= 0xFA && eventType <= 0xFE) { // HARDWARE

            switch (eventType) {
                case 0xFA: // Product Date
                    const year = msg.getBitWord(24, 16, true);
                    const month = msg.getBitWord(40, 8);
                    const day = msg.getBitWord(48, 8);
                    this.hwInfo[eventType] = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
                    break;
                case 0xFC: // Hardware Name
                    this.hwInfo[eventType] = asciiField(msg, 24, dataLength - 1);
                    // SUPERSEDED: asciiField().
                    // this.hwInfo[eventType] = '';
                    // for (let i = 0; i < dataLength - 1; i++) {
                    //     this.hwInfo[eventType] += String.fromCharCode(msg.getBitWord(i * 8 + 24, 8));
                    // }
                    break;
                case 0xFD: // Software Version
                    const swMajor = msg.getBitWord(24, 4);
                    const swMinor = msg.getBitWord(28, 4);
                    this.hwInfo[eventType] = `${swMajor}.${swMinor}`;
                    break;
                case 0xFE: // Hardware Version
                    const hwMajor = msg.getBitWord(24, 4);
                    const hwMinor = msg.getBitWord(28, 4);
                    this.hwInfo[eventType] = `${hwMajor}.${hwMinor}`;
                    break;
            }

            if (!this.hardwareInfoEmitted && Object.keys(this.hwInfo).length === 4) {
                // All fields populated and not yet reported for this request:
                // retransmitted hardware frames must not emit duplicate events.
                this.hardwareInfoEmitted = true;
                cubeEvents.push(this.buildHardwareEvent(timestamp));
            }

        } else if (eventType === 0xEC) { // GYRO

            const firstGyroThisSession = !this.gyroObserved;
            this.gyroObserved = true;

            cubeEvents.push(decodeGyroEvent(msg, timestamp, 16, 80));

            if (firstGyroThisSession && this.hardwareInfoEmitted && Object.keys(this.hwInfo).length === 4) {
                cubeEvents.push(this.buildHardwareEvent(timestamp));
            }

        } else if (eventType === 0xEF) { // BATTERY

            cubeEvents.push(batteryEvent(timestamp, msg.getBitWord(8 + dataLength * 8, 8)));

        } else if (eventType === 0xEA) { // DISCONNECT
            conn.disconnect().catch(() => { /* already disconnected */ });
        }

        return cubeEvents;

    }

}


export { GanGen2ProtocolDriver, GanGen3ProtocolDriver, GanGen4ProtocolDriver };
