
const SOLVED_FACELET = "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB";

const cFacelet = [
    [8, 9, 20],   // URF
    [6, 18, 38],  // UFL
    [0, 36, 47],  // ULB
    [2, 45, 11],  // UBR
    [29, 26, 15], // DFR
    [27, 44, 24], // DLF
    [33, 53, 42], // DBL
    [35, 17, 51]  // DRB
];

const eFacelet = [
    [5, 10],  // UR
    [7, 19],  // UF
    [3, 37],  // UL
    [1, 46],  // UB
    [32, 16], // DR
    [28, 25], // DF
    [30, 43], // DL
    [34, 52], // DB
    [23, 12], // FR
    [21, 41], // FL
    [50, 39], // BL
    [48, 14]  // BR
];

class CubieCube {
    ca: number[];
    ea: number[];

    constructor() {
        this.ca = [0, 1, 2, 3, 4, 5, 6, 7];
        this.ea = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];
    }

    init(ca: number[], ea: number[]): CubieCube {
        this.ca = ca.slice();
        this.ea = ea.slice();
        return this;
    }

    static EdgeMult(a: CubieCube, b: CubieCube, prod: CubieCube): void {
        if (prod === a || prod === b) {
            throw new Error('EdgeMult: prod must be a distinct instance (in-place multiplication corrupts input)');
        }
        for (let ed = 0; ed < 12; ed++) {
            prod.ea[ed] = a.ea[b.ea[ed] >> 1] ^ (b.ea[ed] & 1);
        }
    }

    static CornMult(a: CubieCube, b: CubieCube, prod: CubieCube): void {
        if (prod === a || prod === b) {
            throw new Error('CornMult: prod must be a distinct instance (in-place multiplication corrupts input)');
        }
        for (let corn = 0; corn < 8; corn++) {
            const ori = ((a.ca[b.ca[corn] & 7] >> 3) + (b.ca[corn] >> 3)) % 3;
            prod.ca[corn] = (a.ca[b.ca[corn] & 7] & 7) | (ori << 3);
        }
    }

    static CubeMult(a: CubieCube, b: CubieCube, prod: CubieCube): void {
        CubieCube.CornMult(a, b, prod);
        CubieCube.EdgeMult(a, b, prod);
    }

    toFaceCube(customCFacelet?: number[][], customEFacelet?: number[][]): string {
        const cf = customCFacelet || cFacelet;
        const ef = customEFacelet || eFacelet;
        const f: number[] = [];
        for (let i = 0; i < 54; i++) {
            f[i] = i;
        }
        for (let c = 0; c < 8; c++) {
            const j = this.ca[c] & 0x7;
            const ori = this.ca[c] >> 3;
            for (let n = 0; n < 3; n++) {
                f[cf[c][(n + ori) % 3]] = cf[j][n];
            }
        }
        for (let e = 0; e < 12; e++) {
            const j = this.ea[e] >> 1;
            const ori = this.ea[e] & 1;
            for (let n = 0; n < 2; n++) {
                f[ef[e][(n + ori) % 2]] = ef[j][n];
            }
        }
        const ts = "URFDLB";
        return f.map(v => ts[~~(v / 9)]).join("");
    }

    fromFacelet(facelet: string, customCFacelet?: number[][], customEFacelet?: number[][]): CubieCube | -1 {
        const cf = customCFacelet || cFacelet;
        const ef = customEFacelet || eFacelet;
        if (facelet.length !== 54) {
            return -1;
        }
        const fArr: number[] = [];
        const colorCounts = [0, 0, 0, 0, 0, 0];
        const centers = facelet[4] + facelet[13] + facelet[22] + facelet[31] + facelet[40] + facelet[49];
        for (let i = 0; i < 54; ++i) {
            fArr[i] = centers.indexOf(facelet[i]);
            if (fArr[i] === -1) {
                return -1;
            }
            colorCounts[fArr[i]]++;
        }
        if (colorCounts.some((c) => c !== 9)) {
            return -1;
        }
        // Parse into scratch arrays and require every piece to match exactly once;
        // commit to this.ca/this.ea only after the whole state validated, so a
        // rejected facelet string never leaves the cube partially mutated.
        const ca = new Array<number>(8);
        const ea = new Array<number>(12);
        const cornerUsed = new Array<boolean>(8).fill(false);
        const edgeUsed = new Array<boolean>(12).fill(false);
        for (let i = 0; i < 8; ++i) {
            let ori: number;
            for (ori = 0; ori < 3; ++ori) {
                if (fArr[cf[i][ori]] === 0 || fArr[cf[i][ori]] === 3) break;
            }
            if (ori === 3) {
                return -1; // no U/D sticker on this corner: not a legal corner piece
            }
            const col1 = fArr[cf[i][(ori + 1) % 3]];
            const col2 = fArr[cf[i][(ori + 2) % 3]];
            let matched = false;
            for (let j = 0; j < 8; ++j) {
                if (!cornerUsed[j] && col1 === ~~(cf[j][1] / 9) && col2 === ~~(cf[j][2] / 9)) {
                    cornerUsed[j] = true;
                    ca[i] = j | (ori << 3);
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                return -1; // unknown or duplicate corner piece
            }
        }
        for (let i = 0; i < 12; ++i) {
            let matched = false;
            for (let j = 0; j < 12; ++j) {
                if (edgeUsed[j]) {
                    continue;
                }
                if (fArr[ef[i][0]] === ~~(ef[j][0] / 9) && fArr[ef[i][1]] === ~~(ef[j][1] / 9)) {
                    edgeUsed[j] = true;
                    ea[i] = j << 1;
                    matched = true;
                    break;
                }
                if (fArr[ef[i][0]] === ~~(ef[j][1] / 9) && fArr[ef[i][1]] === ~~(ef[j][0] / 9)) {
                    edgeUsed[j] = true;
                    ea[i] = j << 1 | 1;
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                return -1; // unknown or duplicate edge piece
            }
        }
        this.ca = ca;
        this.ea = ea;
        return this;
    }

    /**
     * Whether this state is reachable by legal turns from solved: corner orientation
     * sum divisible by 3, edge orientation sum even, and matching permutation parity.
     * `fromFacelet` deliberately does not enforce this — a physically twisted corner
     * (after a pop) is a real state a cube can report.
     */
    isSolvable(): boolean {
        let cornerOriSum = 0;
        for (let c = 0; c < 8; c++) {
            cornerOriSum += this.ca[c] >> 3;
        }
        if (cornerOriSum % 3 !== 0) {
            return false;
        }
        let edgeOriSum = 0;
        for (let e = 0; e < 12; e++) {
            edgeOriSum += this.ea[e] & 1;
        }
        if (edgeOriSum % 2 !== 0) {
            return false;
        }
        const permParity = (perm: number[]): number => {
            let inversions = 0;
            for (let i = 0; i < perm.length; i++) {
                for (let j = i + 1; j < perm.length; j++) {
                    if (perm[i] > perm[j]) inversions++;
                }
            }
            return inversions % 2;
        };
        return permParity(this.ca.map((v) => v & 7)) === permParity(this.ea.map((v) => v >> 1));
    }

    static moveCube: CubieCube[] = (() => {
        const mc: CubieCube[] = [];
        for (let i = 0; i < 18; i++) {
            mc[i] = new CubieCube();
        }
        mc[0].init([3, 0, 1, 2, 4, 5, 6, 7], [6, 0, 2, 4, 8, 10, 12, 14, 16, 18, 20, 22]);         // U
        mc[3].init([20, 1, 2, 8, 15, 5, 6, 19], [16, 2, 4, 6, 22, 10, 12, 14, 8, 18, 20, 0]);       // R
        mc[6].init([9, 21, 2, 3, 16, 12, 6, 7], [0, 19, 4, 6, 8, 17, 12, 14, 3, 11, 20, 22]);       // F
        mc[9].init([0, 1, 2, 3, 5, 6, 7, 4], [0, 2, 4, 6, 10, 12, 14, 8, 16, 18, 20, 22]);          // D
        mc[12].init([0, 10, 22, 3, 4, 17, 13, 7], [0, 2, 20, 6, 8, 10, 18, 14, 16, 4, 12, 22]);     // L
        mc[15].init([0, 1, 11, 23, 4, 5, 18, 14], [0, 2, 4, 23, 8, 10, 12, 21, 16, 18, 7, 15]);     // B
        for (let a = 0; a < 18; a += 3) {
            for (let p = 0; p < 2; p++) {
                CubieCube.CubeMult(mc[a + p], mc[a], mc[a + p + 1]);
            }
        }
        return mc;
    })();
}

/**
 * `direction` value for a move in standard notation:
 * 0 = clockwise ("R"), 1 = counter-clockwise ("R'"), 2 = half turn ("R2").
 */
function moveDirectionFromNotation(move: string): 0 | 1 | 2 {
    if (move.endsWith("'")) return 1;
    if (move.endsWith('2')) return 2;
    return 0;
}

export { CubieCube, SOLVED_FACELET, cFacelet, eFacelet, moveDirectionFromNotation };
