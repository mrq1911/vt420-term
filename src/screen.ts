/**
 * The emulated screen as VT420 cells. Every xterm cell becomes exactly one VT420 cell, so pane borders and columns
 * stay where the program put them: a glyph the VT420 lacks gets the charset's nearest one, a double-width character
 * keeps its two columns, and decorations from the Private Use Area (Powerline and Nerd Font symbols) become spaces.
 */

import {
	ATTR_BLINK,
	ATTR_BOLD,
	ATTR_REVERSE,
	ATTR_UNDERLINE,
	BLANK,
	LINE_SINGLE,
	type Line,
} from "@mrq/vt420/cells.js";
import type { Charset } from "@mrq/vt420/charset.js";
import type { IBufferCell, Terminal } from "@xterm/headless";
import {
	DEFAULT_BACKGROUND,
	DEFAULT_FOREGROUND,
	isAccent,
	isLight,
	paletteRgb,
	type Rgb,
	unpackRgb,
} from "./palette.ts";

const SPACE: readonly number[] = [BLANK];

function colour(isDefault: boolean, isRgb: boolean, value: number): Rgb | undefined {
	if (isDefault) return undefined;
	return isRgb ? unpackRgb(value) : paletteRgb(value);
}

/** VT420 attributes for how an xterm cell looks. */
export function cellAttrs(cell: IBufferCell): number {
	const foreground = colour(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor()) ?? DEFAULT_FOREGROUND;
	const background = colour(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor()) ?? DEFAULT_BACKGROUND;
	const [front, back] = cell.isInverse() ? [background, foreground] : [foreground, background];
	const reverse = isLight(back);
	let attrs = reverse ? ATTR_REVERSE : 0;
	if (cell.isBold() || (!reverse && isAccent(front))) attrs |= ATTR_BOLD;
	if (cell.isUnderline() || cell.isItalic()) attrs |= ATTR_UNDERLINE;
	if (cell.isBlink()) attrs |= ATTR_BLINK;
	return attrs;
}

export class ScreenMapper {
	private readonly charset: Charset;
	private readonly glyphs = new Map<string, readonly number[]>();
	private scratch: IBufferCell | undefined;

	constructor(charset: Charset) {
		this.charset = charset;
	}

	/** The visible rows, each exactly as wide as the screen. */
	lines(term: Terminal): Line[] {
		const buffer = term.buffer.active;
		const lines: Line[] = [];
		for (let row = 0; row < term.rows; row++) {
			const line = buffer.getLine(buffer.viewportY + row);
			const cells: number[] = [];
			for (let col = 0; col < term.cols && cells.length < term.cols; col++) {
				const cell = line?.getCell(col, this.scratch);
				if (!cell) {
					cells.push(BLANK);
					continue;
				}
				this.scratch = cell;
				const width = cell.getWidth();
				// the second column of a double-width character, already written with the first
				if (width === 0) continue;
				const attrs = cellAttrs(cell);
				const glyphs = cell.isInvisible() ? SPACE : this.glyphsOf(cell.getChars());
				if (width === 2) {
					cells.push((glyphs[0] ?? this.charset.cell("?")) | attrs, (glyphs[1] ?? BLANK) | attrs);
				} else {
					cells.push((glyphs[0] ?? BLANK) | attrs);
				}
			}
			lines.push({ cells: cells.slice(0, term.cols), attr: LINE_SINGLE });
		}
		return lines;
	}

	/** Where the cursor is, unless the program hid it or it is off the screen. */
	cursor(term: Terminal, visible: boolean): { row: number; col: number } | undefined {
		if (!visible) return undefined;
		const buffer = term.buffer.active;
		if (buffer.cursorY >= term.rows) return undefined;
		return { row: buffer.cursorY, col: Math.min(buffer.cursorX, term.cols - 1) };
	}

	private glyphsOf(chars: string): readonly number[] {
		if (chars === "" || chars === " ") return SPACE;
		let glyphs = this.glyphs.get(chars);
		if (!glyphs) {
			const code = chars.codePointAt(0)!;
			glyphs = code >= 0xe000 && code <= 0xf8ff ? SPACE : this.charset.cells(chars);
			this.glyphs.set(chars, glyphs);
		}
		return glyphs;
	}
}
