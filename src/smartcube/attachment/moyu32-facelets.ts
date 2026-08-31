/**
 * MoYu32 facelet bitstream decoding, shared by the driver and the MAC-probe
 * packet validator so the two cannot drift apart.
 */

/** Decode the 144-bit MoYu32 sticker body into a URFDLB facelet string. */
export function parseMoyu32FaceletBits(faceletBits: string): string {
    const state: string[] = [];
    const faces = [2, 5, 0, 3, 4, 1]; // parse in order URFDLB instead of FBUDLR
    for (let i = 0; i < 6; i++) {
        const face = faceletBits.slice(faces[i] * 24, 24 + faces[i] * 24);
        for (let j = 0; j < 8; j++) {
            state.push("FBUDLR".charAt(parseInt(face.slice(j * 3, 3 + j * 3), 2)));
            if (j === 3) {
                state.push("FBUDLR".charAt(faces[i]));
            }
        }
    }
    return state.join('');
}
