
import { GanCubeMove } from './gan-cube-protocol';

/**
 * Return current host clock timestamp with millisecond precision
 * Use monotonic clock when available (windows, workers, and Node all expose
 * globalThis.performance)
 * @returns Current host clock timestamp in milliseconds
 */
const now: () => number =
    typeof globalThis !== 'undefined' && typeof globalThis.performance?.now === 'function' ?
        () => Math.floor(globalThis.performance.now()) :
        () => Date.now();

/** Fallback spacing for recovered moves with no bounding timestamps on one side. */
const FALLBACK_MOVE_INTERVAL_MS = 50;

/**
 * Least-squares fit over the valid (x, y) pairs, computed mean-centered so large
 * absolute timestamps do not cancel catastrophically. Returns null slope when it
 * is not estimable (fewer than two pairs, or no x variance); the intercept then
 * corresponds to slope 1.
 */
function linregress(X: Array<number | null>, Y: Array<number | null>): [number | null, number] {
    let n = 0;
    let meanX = 0;
    let meanY = 0;
    for (let i = 0; i < X.length; i++) {
        const x = X[i];
        const y = Y[i];
        if (x == null || y == null) {
            continue;
        }
        n++;
        meanX += x;
        meanY += y;
    }
    if (n === 0) {
        return [null, 0];
    }
    meanX /= n;
    meanY /= n;
    let covXY = 0;
    let varX = 0;
    for (let i = 0; i < X.length; i++) {
        const x = X[i];
        const y = Y[i];
        if (x == null || y == null) {
            continue;
        }
        covXY += (x - meanX) * (y - meanY);
        varX += (x - meanX) * (x - meanX);
    }
    if (n < 2 || varX < 1e-6) {
        return [null, meanY - meanX];
    }
    const slope = covXY / varX;
    return [slope, meanY - slope * meanX];
}

/**
 * Use linear regression to fit timestamps reported by cube hardware with host device timestamps.
 * Missing cube timestamps (recovered moves) bounded by known ones are interpolated across the
 * gap; unbounded gaps at either end fall back to 50 ms spacing.
 *
 * Note: cube timestamps are used as reported — a cube clock that wraps inside the fitted window
 * would corrupt the fit, so keep windows short relative to the cube's clock range.
 * @param cubeMoves List representing window of cube moves to operate on
 * @returns New copy of move list with fitted cubeTimestamp values
 */
function cubeTimestampLinearFit(cubeMoves: Array<GanCubeMove>): Array<GanCubeMove> {
    // Work on copies: the caller's move objects are never modified.
    const moves: Array<GanCubeMove> = cubeMoves.map(m => ({ ...m }));
    // Fill timestamp values for missed and recovered cube moves.
    let i = 0;
    while (i < moves.length) {
        if (moves[i].cubeTimestamp != null) {
            i++;
            continue;
        }
        let j = i;
        while (j < moves.length && moves[j].cubeTimestamp == null) {
            j++;
        }
        const prev = i > 0 ? moves[i - 1].cubeTimestamp : null;
        const next = j < moves.length ? moves[j].cubeTimestamp : null;
        if (prev != null && next != null) {
            // Bounded gap: distribute the missing moves evenly across it.
            const step = (next - prev) / (j - i + 1);
            for (let k = i; k < j; k++) {
                moves[k].cubeTimestamp = Math.round(prev + step * (k - i + 1));
            }
        } else if (prev != null) {
            for (let k = i; k < j; k++) {
                moves[k].cubeTimestamp = prev + FALLBACK_MOVE_INTERVAL_MS * (k - i + 1);
            }
        } else if (next != null) {
            for (let k = i; k < j; k++) {
                moves[k].cubeTimestamp = next - FALLBACK_MOVE_INTERVAL_MS * (j - k);
            }
        }
        i = j;
    }
    // Either every move now has a cube timestamp or none does.
    if (moves.length === 0 || moves[0].cubeTimestamp == null) {
        return moves;
    }
    // Apply linear regression to the cube timestamps
    const res: Array<GanCubeMove> = [];
    const [fittedSlope, intercept] = linregress(moves.map(m => m.cubeTimestamp), moves.map(m => m.localTimestamp));
    const slope = fittedSlope ?? 1;
    const first = Math.round(slope * moves[0].cubeTimestamp + intercept);
    moves.forEach(m => {
        res.push({
            face: m.face,
            direction: m.direction,
            move: m.move,
            localTimestamp: m.localTimestamp,
            cubeTimestamp: Math.round(slope * m.cubeTimestamp! + intercept) - first
        });
    });
    return res;
}

/**
 * Calculate time skew degree in percent between cube hardware and host device
 * @param cubeMoves List representing window of cube moves to operate on
 * @returns Time skew value in percent; NaN when the skew is not estimable from
 *          the provided window (fewer than two timestamped moves, or no spread)
 */
function cubeTimestampCalcSkew(cubeMoves: Array<GanCubeMove>): number {
    if (!cubeMoves.length) return 0;
    const [slope] = linregress(cubeMoves.map(m => m.localTimestamp), cubeMoves.map(m => m.cubeTimestamp));
    if (slope == null) {
        return NaN;
    }
    return Math.round((slope - 1) * 100000) / 1000;
}

const CORNER_FACELET_MAP = [
    [8, 9, 20], // URF
    [6, 18, 38], // UFL
    [0, 36, 47], // ULB
    [2, 45, 11], // UBR
    [29, 26, 15], // DFR
    [27, 44, 24], // DLF
    [33, 53, 42], // DBL
    [35, 17, 51]  // DRB
];

const EDGE_FACELET_MAP = [
    [5, 10], // UR
    [7, 19], // UF
    [3, 37], // UL
    [1, 46], // UB
    [32, 16], // DR
    [28, 25], // DF
    [30, 43], // DL
    [34, 52], // DB
    [23, 12], // FR
    [21, 41], // FL
    [50, 39], // BL
    [48, 14]  // BR
];

function isPermutationOf(arr: Array<number>, size: number): boolean {
    if (arr.length !== size) {
        return false;
    }
    const seen = new Array<boolean>(size).fill(false);
    for (const v of arr) {
        if (!Number.isInteger(v) || v < 0 || v >= size || seen[v]) {
            return false;
        }
        seen[v] = true;
    }
    return true;
}

/**
 *
 * Convert Corner/Edge Permutation/Orientation cube state to the Kociemba facelets representation string
 *
 * Example - solved state:
 *   cp = [0, 1, 2, 3, 4, 5, 6, 7]
 *   co = [0, 0, 0, 0, 0, 0, 0, 0]
 *   ep = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
 *   eo = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
 *   facelets = "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB"
 * Example - state after F R moves made:
 *   cp = [0, 5, 2, 1, 7, 4, 6, 3]
 *   co = [1, 2, 0, 2, 1, 1, 0, 2]
 *   ep = [1, 9, 2, 3, 11, 8, 6, 7, 4, 5, 10, 0]
 *   eo = [1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0]
 *   facelets = "UUFUUFLLFUUURRRRRRFFRFFDFFDRRBDDBDDBLLDLLDLLDLBBUBBUBB"
 *
 * @param cp Corner Permutation
 * @param co Corner Orientation
 * @param ep Egde Permutation
 * @param eo Edge Orientation
 * @returns Cube state in the Kociemba facelets representation string
 * @throws Error when the arrays are not a structurally valid cube state
 *
 */
function toKociembaFacelets(cp: Array<number>, co: Array<number>, ep: Array<number>, eo: Array<number>): string {
    if (!isPermutationOf(cp, 8)) {
        throw new Error('toKociembaFacelets: cp must be a permutation of 0..7');
    }
    if (co.length !== 8 || co.some(v => !Number.isInteger(v) || v < 0 || v > 2)) {
        throw new Error('toKociembaFacelets: co must be 8 integers in [0,2]');
    }
    if (!isPermutationOf(ep, 12)) {
        throw new Error('toKociembaFacelets: ep must be a permutation of 0..11');
    }
    if (eo.length !== 12 || eo.some(v => v !== 0 && v !== 1)) {
        throw new Error('toKociembaFacelets: eo must be 12 values in {0,1}');
    }
    const faces = "URFDLB";
    const facelets: Array<string> = [];
    for (let i = 0; i < 54; i++) {
        facelets[i] = faces[~~(i / 9)];
    }
    for (let i = 0; i < 8; i++) {
        for (let p = 0; p < 3; p++) {
            facelets[CORNER_FACELET_MAP[i][(p + co[i]) % 3]] = faces[~~(CORNER_FACELET_MAP[cp[i]][p] / 9)];
        }
    }
    for (let i = 0; i < 12; i++) {
        for (let p = 0; p < 2; p++) {
            facelets[EDGE_FACELET_MAP[i][(p + eo[i]) % 2]] = faces[~~(EDGE_FACELET_MAP[ep[i]][p] / 9)];
        }
    }
    return facelets.join('');
}

export {
    now,
    cubeTimestampLinearFit,
    cubeTimestampCalcSkew,
    toKociembaFacelets,
}

