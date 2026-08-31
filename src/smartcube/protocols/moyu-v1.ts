import { writeGattCharacteristicValue } from '../../gatt-characteristic-write';

/**
 * MoYu BLE API v1: fragmented request/response on 0x1001 / 0x1002 and cube-state payload parsing.
 */

const MOYU_V1_CMD_HW = 2;
const MOYU_V1_CMD_BATTERY = 3;
const MOYU_V1_CMD_CUBE_STATE = 10;

/** Sticker id 0–5 → center color letter (MoYu face order D,L,B,R,F,U). */
const STICKER_ID_TO_COLOR = 'DLBRFU';

/**
 * Map MoYu face index × cell (0–8) to URFDLB linear facelet index (U 0–8, R 9–17, …)
 */
const MOYU_CELL_TO_STD: readonly (readonly number[])[] = [
    [27, 28, 29, 30, 31, 32, 33, 34, 35],
    [44, 43, 42, 41, 40, 39, 38, 37, 36],
    [53, 52, 51, 50, 49, 48, 47, 46, 45],
    [17, 16, 26, 14, 13, 12, 11, 10, 9],
    [29, 25, 24, 23, 22, 21, 20, 19, 18],
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
];

const MOYU_V1_SOLVED_STICKERS: number[][] = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1, 1, 1, 1, 1],
    [2, 2, 2, 2, 2, 2, 2, 2, 2],
    [3, 3, 3, 3, 3, 3, 3, 3, 3],
    [4, 4, 4, 4, 4, 4, 4, 4, 4],
    [5, 5, 5, 5, 5, 5, 5, 5, 5],
];

interface PacketPart {
    readonly index: number;
    readonly total: number;
    readonly payload: Uint8Array;
}

function parseIncomingPart(dv: DataView): PacketPart {
    const index = dv.getUint8(1) & 15;
    const total = dv.getUint8(1) >> 4;
    const payload = new Uint8Array(dv.buffer, dv.byteOffset + 2, Math.max(0, dv.byteLength - 2));
    return { index, total, payload };
}

function mergeParts(parts: PacketPart[]): DataView {
    const sorted = [...parts].sort((a, b) => a.index - b.index);
    const len = sorted.reduce((n, p) => n + p.payload.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of sorted) {
        out.set(p.payload, o);
        o += p.payload.length;
    }
    return new DataView(out.buffer);
}

function parseResponse(merged: DataView, timestamp: number): {
    command: number;
    success: boolean;
    id: number;
    timestamp: number;
    payload: DataView;
} {
    const header = merged.getUint8(0);
    const command = header & 15;
    const success = ((header >> 4) & 1) === 1;
    const id = (header >> 5) & 7;
    const payload = new DataView(merged.buffer, merged.byteOffset + 1, merged.byteLength - 1);
    return { command, success, id, timestamp, payload };
}

function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array {
    const o = new Uint8Array(a.length + b.length);
    o.set(a);
    o.set(b, a.length);
    return o;
}

class IdGenerator {
    private lastId = 0;
    next(): number {
        this.lastId = (this.lastId + 1) % 8;
        return this.lastId;
    }
}

class SendCountGenerator {
    private lastCount = -1;
    next(): number {
        this.lastCount = (this.lastCount + 1) % 256;
        return this.lastCount;
    }
}

type Waiter = {
    command: number;
    id: number;
    sentAt: number;
    resolve: (v: { sentAt: number; receivedAt: number; value: DataView }) => void;
    reject: (e: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

export interface MoyuV1CubeStatePayload {
    readonly stickers: number[][];
    readonly angles: number[];
}

export function moyuV1ParseCubeStatePayload(payload: DataView): MoyuV1CubeStatePayload {
    // 54 sticker ids packed two-per-byte (low nibble first), then 6 face angles the same way.
    const stickers: number[][] = [];
    for (let face = 0; face < 6; face++) {
        const faceStickers: number[] = [];
        for (let cell = 0; cell < 9; cell++) {
            const packed = payload.getUint8(Math.floor((9 * face + cell) / 2));
            faceStickers.push((packed >> ((9 * face + cell) % 2 === 0 ? 0 : 4)) & 15);
        }
        stickers.push(faceStickers);
    }
    const angles: number[] = [];
    for (let face = 0; face < 6; face++) {
        const packed = payload.getUint8(27 + Math.floor(face / 2));
        angles.push((packed >> (face % 2 === 0 ? 0 : 4)) & 15);
    }
    return { stickers, angles };
}

export function moyuV1EncodeCubeStatePayload(stickers: number[][], angles: number[]): Uint8Array {
    const out = new Uint8Array(30);
    const view = new DataView(out.buffer);
    for (let face = 0; face < 6; face++) {
        for (let cell = 0; cell < 9; cell++) {
            const lowNibble = (9 * face + cell) % 2 === 0;
            const byteIndex = Math.floor((9 * face + cell) / 2);
            view.setUint8(byteIndex, view.getUint8(byteIndex) | ((15 & stickers[face]![cell]!) << (lowNibble ? 0 : 4)));
        }
    }
    for (let face = 0; face < 6; face++) {
        const lowNibble = face % 2 === 0;
        const byteIndex = 27 + Math.floor(face / 2);
        view.setUint8(byteIndex, view.getUint8(byteIndex) | ((15 & angles[face]!) << (lowNibble ? 0 : 4)));
    }
    return out;
}

/** Build 54-char URFDLB facelet string for CubieCube.fromFacelet. */
export function moyuStickersToFaceletString(stickers: number[][]): string {
    const chars: string[] = new Array(54).fill('?');
    for (let face = 0; face < 6; face++) {
        const row = MOYU_CELL_TO_STD[face]!;
        const stickerRow = stickers[face]!;
        for (let p = 0; p < 9; p++) {
            const id = stickerRow[p]! & 15;
            const c = id < 6 ? STICKER_ID_TO_COLOR[id]! : '?';
            chars[row[p]!] = c;
        }
    }
    return chars.join('');
}

export interface MoyuV1HardwareInfo {
    readonly bootCount: number;
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
}

export interface MoyuV1BatteryInfo {
    readonly charging: boolean;
    readonly full: boolean;
    readonly percentage: number;
    readonly voltage: number;
}

export class MoyuV1Client {
    private readonly idGen = new IdGenerator();
    private readonly sendCountGen = new SendCountGenerator();
    private incomplete: PacketPart[] = [];
    private waiters: Waiter[] = [];

    constructor(private readonly writeCharacteristic: BluetoothRemoteGATTCharacteristic) {}

    /** Call from 0x1002 notification handler. */
    onReadNotification(dv: DataView): void {
        const part = parseIncomingPart(dv);
        this.incomplete.push(part);
        if (part.total <= 0 || part.index !== part.total - 1) {
            return;
        }
        const merged = mergeParts(this.incomplete);
        this.incomplete = [];
        if (merged.byteLength === 0) {
            return; // no header byte: nothing to dispatch
        }
        const receivedAt = Date.now();
        const r = parseResponse(merged, receivedAt);
        const idx = this.waiters.findIndex((w) => w.command === r.command && w.id === r.id);
        if (idx < 0) {
            return;
        }
        const w = this.waiters.splice(idx, 1)[0]!;
        clearTimeout(w.timeout);
        if (!r.success) {
            w.reject(new Error(`MoYu v1 command ${r.command} failed`));
            return;
        }
        w.resolve({ sentAt: w.sentAt, receivedAt, value: r.payload });
    }

    private headerByte(command: number, hasPayload: boolean, id: number): number {
        return command | ((hasPayload ? 1 : 0) << 4) | (id << 5);
    }

    private async sendRawRequest(body: Uint8Array): Promise<number> {
        const nParts = Math.ceil(body.length / 18);
        if (nParts > 16) throw new Error('Too many parts');
        for (let i = 0; i < nParts; i++) {
            const frame = new Uint8Array(20);
            const v = new DataView(frame.buffer);
            v.setUint8(0, this.sendCountGen.next());
            v.setUint8(1, i | (nParts << 4));
            const slice = body.subarray(18 * i, 18 * (i + 1));
            frame.set(slice, 2);
            await writeGattCharacteristicValue(this.writeCharacteristic, frame);
        }
        return Date.now();
    }

    async send(command: number, payload?: Uint8Array): Promise<{
        sentAt: number;
        receivedAt: number;
        value: DataView;
    }> {
        const id = this.idGen.next();
        const hasPayload = payload !== undefined;
        const h = this.headerByte(command, hasPayload, id);
        const first = new Uint8Array(1);
        new DataView(first.buffer).setUint8(0, h);
        const body = hasPayload && payload !== undefined ? concatU8(first, payload) : first;

        let waiter: Waiter;
        const result = new Promise<{ sentAt: number; receivedAt: number; value: DataView }>(
            (resolve, reject) => {
                const timeout = setTimeout(() => {
                    const i = this.waiters.findIndex((w) => w.command === command && w.id === id);
                    if (i >= 0) this.waiters.splice(i, 1);
                    reject(new Error(`MoYu v1 command ${command} timeout`));
                }, 5000);
                waiter = { command, id, sentAt: 0, resolve, reject, timeout };
                this.waiters.push(waiter);
            },
        );

        try {
            waiter!.sentAt = await this.sendRawRequest(body);
        } catch (e) {
            // The request never left the host: drop the waiter so its timeout cannot
            // later reject a promise nobody holds.
            clearTimeout(waiter!.timeout);
            const i = this.waiters.indexOf(waiter!);
            if (i >= 0) this.waiters.splice(i, 1);
            throw e;
        }
        return result;
    }

    async getCubeState(): Promise<MoyuV1CubeStatePayload> {
        const r = await this.send(MOYU_V1_CMD_CUBE_STATE);
        return moyuV1ParseCubeStatePayload(r.value);
    }

    async setCubeState(
        stickers: number[][] = MOYU_V1_SOLVED_STICKERS,
        angles: number[] = [0, 0, 0, 0, 0, 0],
    ): Promise<void> {
        const pl = moyuV1EncodeCubeStatePayload(stickers, angles);
        await this.send(MOYU_V1_CMD_CUBE_STATE, pl);
    }

    async getBatteryInfo(): Promise<{
        sentAt: number;
        receivedAt: number;
        value: MoyuV1BatteryInfo;
    }> {
        const response = await this.send(MOYU_V1_CMD_BATTERY);
        const data = response.value;
        return {
            sentAt: response.sentAt,
            receivedAt: response.receivedAt,
            value: {
                charging: !!data.getUint8(0),
                full: !!data.getUint8(1),
                percentage: data.getUint16(2, true),
                voltage: data.getInt32(4, true) / 1000,
            },
        };
    }

    async getHardwareInfo(): Promise<MoyuV1HardwareInfo> {
        const response = await this.send(MOYU_V1_CMD_HW);
        const data = response.value;
        return {
            bootCount: data.getUint32(16, true),
            major: data.getUint8(20),
            minor: data.getUint8(21),
            patch: data.getUint16(22, true),
        };
    }

}

export { MOYU_V1_SOLVED_STICKERS };
