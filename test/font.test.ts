import { describe, expect, it } from "vitest";
import { CODE_SHIFT, Vt420 } from "../src/emu/vt420.ts";
import { glyphRows, slotFor } from "../src/web/font.ts";

/** The glyph slots of the first cells of the first line, after feeding. */
function slots(bytes: string, cells: number, term = new Vt420()): (number | undefined)[] {
	term.feed(bytes);
	const line = term.screenLine(0)!;
	return line.chars.slice(0, cells).map((char, col) => slotFor(char, (line.attrs[col] ?? 0) >> CODE_SHIFT));
}

describe("the VT420's font", () => {
	it("draws each cell with the glyph firmware V1.4 draws it with, by the set it came from", () => {
		// slots as the firmware put them in video memory, running in Blaze
		expect(slots("A£", 2)).toEqual([0x41, 0xa3]);
		expect(slots("\x1b(0l}_\x1b(B", 3)).toEqual([13, 30, 0]);
		expect(slots("\x1b(>\x22p8\x1b(B", 3)).toEqual([0x122, 0x170, 0x11a]);
		expect(slots("\x1b)%5\x0eW]w$\x0f", 4)).toEqual([0x198, 0x199, 0x19a, 0x11a]);
		expect(slots("\x1a", 1)).toEqual([0x11a]);
	});

	it("takes a character UTF-8 brought by the character, whatever its code point", () => {
		const bytes = Buffer.from("က┌π", "utf8").toString("latin1");
		expect(slots(bytes, 3, new Vt420({ utf8: true }))).toEqual([undefined, 13, 28]);
	});

	it("has the terminal's dots, two to a stroke", () => {
		const art = glyphRows(0x41, 16, false).map((row) =>
			Array.from({ length: 10 }, (_, dot) => (row & (1 << dot) ? "#" : ".")).join(""),
		);
		expect(art.slice(3, 13)).toEqual([
			"....##....",
			"...####...",
			"..##..##..",
			"..##..##..",
			".##....##.",
			".########.",
			".##....##.",
			".##....##.",
			".##....##.",
			".##....##.",
		]);
		expect(glyphRows(0x41, 8, true)).toHaveLength(8);
	});
});
