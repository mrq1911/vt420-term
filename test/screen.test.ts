import { Unicode11Addon } from "@xterm/addon-unicode11";
import xterm from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { isAccent, isLight, paletteRgb } from "../src/palette.ts";
import { ScreenMapper } from "../src/screen.ts";
import { ATTR_BLINK, ATTR_BOLD, ATTR_MASK, ATTR_REVERSE, ATTR_UNDERLINE, type Line } from "../src/vt420/cells.ts";
import { Charset } from "../src/vt420/charset.ts";
import { cellsText } from "./emulator.ts";

const charset = new Charset({ technical: true, supplemental: "dec", eightBit: false });

async function mapped(text: string, cols = 40, rows = 4) {
	const term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
	term.loadAddon(new Unicode11Addon());
	term.unicode.activeVersion = "11";
	await new Promise<void>((resolve) => term.write(text, resolve));
	const mapper = new ScreenMapper(charset);
	return { term, mapper, lines: mapper.lines(term) };
}

/** Attributes of the cells under `needle` in row 0, which must all agree. */
function attrsOf(lines: Line[], needle: string): number {
	const text = cellsText(lines[0]!.cells);
	const start = text.indexOf(needle);
	expect(start, `${needle} in ${text}`).toBeGreaterThanOrEqual(0);
	const attrs = new Set(lines[0]!.cells.slice(start, start + needle.length).map((cell) => cell & ATTR_MASK));
	expect(attrs.size, `one rendition for ${needle}`).toBe(1);
	return [...attrs][0]!;
}

describe("colours on a monochrome terminal", () => {
	it("judges zellij's palette the way its bars need", () => {
		// bar black, active tab green, inactive tab grey, plain text white
		expect([16, 154, 245, 255].map((index) => isLight(paletteRgb(index)))).toEqual([false, true, false, true]);
		// focus green, orange and cyan accents, red keys stand out; grey and white do not
		expect([154, 166, 51, 124, 245, 255].map((index) => isAccent(paletteRgb(index)))).toEqual([
			true,
			true,
			true,
			true,
			false,
			false,
		]);
	});

	it("inverts the active tab, not the bar or the inactive tabs, and bolds accents", async () => {
		const { lines } = await mapped(
			"\x1b[1;38;5;255;48;5;16m bar \x1b[0;38;5;16;48;5;154m active \x1b[0;38;5;16;48;5;245m idle \x1b[0;38;5;154mframe\x1b[0;38;5;245m dim\x1b[0m",
		);
		expect(attrsOf(lines, "bar")).toBe(ATTR_BOLD);
		expect(attrsOf(lines, "active")).toBe(ATTR_REVERSE);
		expect(attrsOf(lines, "idle")).toBe(0);
		expect(attrsOf(lines, "frame")).toBe(ATTR_BOLD);
		expect(attrsOf(lines, "dim")).toBe(0);
	});

	it("never turns colour numbers into VT420 attributes", async () => {
		// a VT420 reading 38;2;0;5;7 itself would switch on blink and reverse
		const { lines } = await mapped("\x1b[38;2;0;5;7mrgb\x1b[38;5;5mcube\x1b[0m");
		expect(attrsOf(lines, "rgb")).toBe(0);
		expect(attrsOf(lines, "cube")).toBe(ATTR_BOLD);
	});

	it("keeps the attributes the VT420 has and maps the rest", async () => {
		const { lines } = await mapped("\x1b[7minv\x1b[0m \x1b[3mital\x1b[0m \x1b[5mblink\x1b[0m \x1b[4munder\x1b[0m");
		expect(attrsOf(lines, "inv")).toBe(ATTR_REVERSE);
		expect(attrsOf(lines, "ital")).toBe(ATTR_UNDERLINE);
		expect(attrsOf(lines, "blink")).toBe(ATTR_BLINK);
		expect(attrsOf(lines, "under")).toBe(ATTR_UNDERLINE);
	});
});

describe("screen mapping", () => {
	it("keeps every cell in its column", async () => {
		const { lines } = await mapped("a漢b\u{1f680}cd|");
		expect(cellsText(lines[0]!.cells).slice(0, 10)).toBe("a? b? c d|");
		expect(lines.every((line) => line.cells.length === 40)).toBe(true);
	});

	it("draws box drawing and accents with DEC glyphs", async () => {
		const { lines } = await mapped("╭─╮ ü ≥ π");
		expect(cellsText(lines[0]!.cells).trimEnd()).toBe("┌─┐ ü ≥ π");
	});

	it("hides invisible text and reports the cursor", async () => {
		const { term, mapper, lines } = await mapped("\x1b[8msecret\x1b[0m\r\nab");
		expect(cellsText(lines[0]!.cells).trim()).toBe("");
		expect(mapper.cursor(term, true)).toEqual({ row: 1, col: 2 });
		expect(mapper.cursor(term, false)).toBeUndefined();
	});
});
