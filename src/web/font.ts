/**
 * Which of the VT420's glyphs a cell draws, and the glyph's dots. The firmware picks a glyph by the set a character
 * came from, so a cell is looked up by the code the terminal keeps it as (see storedCode) where that tells more than
 * the character: DEC Technical's ┌ is not line drawing's, nor its π the Latin-1 one's.
 */

import { SPECIAL_GRAPHICS, TECHNICAL, TECHNICAL_SIGMA_PREVIEW } from "../vt420/charset.ts";
import { FONTS } from "./font-data.ts";

/** Scan lines a row of characters has: 16 at 24 lines a screen, 10 at 36, 8 at 48. */
export type Rows = 16 | 10 | 8;

/** The scan line underline lights, as the firmware sets the video processor for each height of row. */
export const UNDERLINE_ROW: Readonly<Record<Rows, number>> = { 16: 13, 10: 9, 8: 7 };

/** Characters past Latin-1 by their glyph: the DEC Supplemental letters, then line drawing and DEC Technical, as UTF-8 brings them. */
const BEYOND_LATIN1 = new Map<string, number>([
	["Œ", 0x198],
	["Ÿ", 0x199],
	["œ", 0x19a],
]);
for (const [code, char] of SPECIAL_GRAPHICS) {
	if (code > 0x5f && !BEYOND_LATIN1.has(char) && char > "\xff") BEYOND_LATIN1.set(char, code - 0x5f);
}
for (const [code, char] of [...TECHNICAL, ...TECHNICAL_SIGMA_PREVIEW]) {
	if (!BEYOND_LATIN1.has(char) && char > "\xff") BEYOND_LATIN1.set(char, 0x100 | code);
}

/** The glyph a cell draws, from its character and the code the terminal keeps it as; undefined where the VT420 has none. */
export function slotFor(char: string, stored: number): number | undefined {
	const point = char.codePointAt(0) ?? 0;
	// a code other than the character itself names the set: DEC Technical (the error character too), or line drawing
	if (stored !== point) {
		if (stored >= 0x1000 && stored < 0x1100) return 0x100 | (stored & 0xff);
		if (stored > 0 && stored < 0x20) return stored;
	}
	// a no-break space is blank: the font's 0xA0 is a picture of one, for showing controls
	if (point === 0xa0) return 0;
	if ((point >= 0x20 && point < 0x7f) || (point > 0xa0 && point < 0x100)) return point;
	return BEYOND_LATIN1.get(char);
}

const decoded = new Map<Rows, Uint8Array>();

/** A glyph's rows, dot 0 (the leftmost) in each one's lowest bit: ten dots wide, or six for 132 columns. */
export function glyphRows(slot: number, rows: Rows, narrow: boolean): number[] {
	let bytes = decoded.get(rows);
	if (!bytes) {
		bytes = Uint8Array.from(atob(FONTS[rows]), (c) => c.charCodeAt(0));
		decoded.set(rows, bytes);
	}
	const at = slot * 32;
	const out: number[] = [];
	for (let row = 0; row < rows; row++) {
		const high = bytes[at + 16 + row] ?? 0;
		out.push(narrow ? high >> 2 : (bytes[at + row] ?? 0) | ((high & 3) << 8));
	}
	return out;
}
