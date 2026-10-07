/**
 * The VT420's screen on a canvas: rows of cells in a phosphor's two intensities, drawn dot for dot from the terminal's
 * own font, line attributes, blink, the cursor, the status line, soft characters, and a scroll gliding a scan line at
 * a time.
 */

import {
	ATTR_BLINK,
	ATTR_BOLD,
	ATTR_INVISIBLE,
	ATTR_REVERSE,
	ATTR_UNDERLINE,
	CODE_SHIFT,
	type EmuLine,
	LINE_DOUBLE_BOTTOM,
	LINE_DOUBLE_TOP,
	LINE_SINGLE,
	type SmoothScroll,
	type Vt420,
} from "../emu/vt420.ts";
import { glyphRows, type Rows, slotFor, UNDERLINE_ROW } from "./font.ts";
import { PICTURES, SHADES, SHAPES, STROKES } from "./glyphs.ts";

export type Phosphor = "white" | "green" | "amber";

const PHOSPHORS: Readonly<Record<Phosphor, [number, number, number]>> = {
	white: [238, 244, 255],
	green: [92, 255, 140],
	amber: [255, 184, 72],
};

/** Normal characters are this much of bold ones. */
const NORMAL = 0.72;

export type Weight = "thin" | "medium" | "heavy";
export type Persistence = "off" | "short" | "medium" | "long";

/** How far, in dots, each weight spreads a lit dot to the right, as a beam driven harder does. */
const STRETCH: Readonly<Record<Weight, number>> = { thin: 0, medium: 0.25, heavy: 0.5 };

/** How long, in milliseconds, a lit dot takes to fade to a third (the phosphor's persistence). */
const PERSISTENCE: Readonly<Record<Persistence, number>> = { off: 0, short: 30, medium: 60, long: 120 };

/** The two thumbwheels under the screen, each from 0 to 1. */
export interface Knobs {
	brightness: number;
	contrast: number;
}

/** The dark border the picture keeps inside the tube, of its width and its height. */
const PAD_X = 0.035;
const PAD_Y = 0.045;

/** Of a cell's height, where the font's band starts above the baseline and ends below it (VT323 units), for what the VT420 has no glyph for. */
const FONT_TOP = 760;
const FONT_BOTTOM = -200;

export interface Glide {
	event: SmoothScroll;
	start: number;
	duration: number;
}

export interface Selection {
	from: { row: number; col: number };
	to: { row: number; col: number };
}

export interface FrameState {
	glide?: Glide;
	/** What the indicator status line says. */
	indicator: string;
	selection?: Selection;
	cursorStyle: "block" | "underline";
	cursorBlink: boolean;
}

/** A cell as the renderer last drew it, to tell what changed. */
type RowKey = string;

export class Renderer {
	/** The tube: what was drawn, fading as a phosphor does, under what is drawn now. */
	readonly canvas: HTMLCanvasElement;
	private readonly screen: CanvasRenderingContext2D;
	/** The picture as the terminal draws it now, row by row as rows change. */
	private readonly frame: HTMLCanvasElement;
	private readonly ctx: CanvasRenderingContext2D;
	/** The terminal shown: the one the program writes to, or Set-Up's. */
	term: Vt420;
	private phosphor: [number, number, number] = PHOSPHORS.white;
	private knobs: Knobs = { brightness: 0.35, contrast: 0.7 };
	private weight: Weight = "thin";
	private persistence: Persistence = "medium";
	private lastComposite = 0;
	private settleUntil = 0;
	private drawn: RowKey[] = [];
	private width = 0;
	private height = 0;
	private padX = 0;
	private padY = 0;
	private cellW = 0;
	private cellH = 0;
	private widths = new Map<string, number>();
	private shade: CanvasPattern | undefined;
	private shadeKey = "";

	constructor(canvas: HTMLCanvasElement, term: Vt420) {
		this.canvas = canvas;
		this.screen = canvas.getContext("2d", { alpha: false })!;
		this.frame = document.createElement("canvas");
		this.ctx = this.frame.getContext("2d", { alpha: false })!;
		this.term = term;
	}

	/** Brightness lifts the black of the tube and everything with it; contrast is how strongly characters light. */
	setKnobs(knobs: Knobs): void {
		this.knobs = { brightness: clamp01(knobs.brightness), contrast: clamp01(knobs.contrast) };
		this.canvas.style.setProperty("--glow", String(0.15 + 0.35 * this.knobs.contrast));
		this.invalidate();
	}

	setLook(weight: Weight, persistence: Persistence): void {
		this.weight = weight;
		this.persistence = persistence;
		this.invalidate();
	}

	setPhosphor(phosphor: Phosphor): void {
		this.phosphor = PHOSPHORS[phosphor];
		const [r, g, b] = this.phosphor;
		this.canvas.style.setProperty("--phosphor", `${r} ${g} ${b}`);
		this.invalidate();
	}

	/** Size the canvas to its box on the page, at the display's pixel density. */
	resize(): void {
		const ratio = window.devicePixelRatio || 1;
		const box = this.canvas.getBoundingClientRect();
		this.width = Math.max(1, Math.round(box.width * ratio));
		this.height = Math.max(1, Math.round(box.height * ratio));
		this.canvas.width = this.width;
		this.canvas.height = this.height;
		this.frame.width = this.width;
		this.frame.height = this.height;
		this.invalidate();
	}

	invalidate(): void {
		this.drawn = [];
	}

	/** The cell under a point of the page, rows counted on the screen with the status line last. */
	cellAt(clientX: number, clientY: number): { row: number; col: number } | undefined {
		const box = this.canvas.getBoundingClientRect();
		const ratio = this.width / Math.max(1, box.width);
		const x = (clientX - box.left) * ratio - this.padX;
		const y = (clientY - box.top) * ratio - this.padY;
		const row = Math.floor(y / this.cellH);
		const slots = this.term.screenLines + 1;
		if (row < 0 || row >= slots) return undefined;
		const line = this.lineAt(row);
		const double = line && line.lineAttr !== LINE_SINGLE ? 2 : 1;
		const col = Math.floor(x / (this.cellW * double));
		const width = this.term.columns / double;
		return { row, col: Math.max(0, Math.min(width - 1, col)) };
	}

	/** The line on a screen row, the status line in the last; undefined for a row with nothing. */
	lineAt(row: number, indicator?: string): EmuLine | undefined {
		const term = this.term;
		if (row < term.visibleLines) return term.screenLine(row);
		if (row !== term.screenLines || term.statusType === 0) return undefined;
		if (term.statusType === 2) return term.status;
		return indicator === undefined ? term.status : indicatorLine(indicator, term.columns);
	}

	/** Where the character rows are in a box `height` high: their height, and the top of the first. */
	rows(height: number): { rowHeight: number; top: number } {
		const ratio = this.height / Math.max(1, height);
		const slots = this.term.screenLines + 1;
		const cell = Math.floor((this.height * (1 - 2 * PAD_Y)) / slots);
		return { rowHeight: cell / ratio, top: Math.round((this.height - cell * slots) / 2) / ratio };
	}

	draw(now: number, state: FrameState): void {
		const term = this.term;
		const slots = term.screenLines + 1;
		this.padX = Math.round(this.width * PAD_X);
		this.cellW = (this.width - 2 * this.padX) / term.columns;
		// whole pixels a row, so rows drawn one by one meet without a seam
		this.cellH = Math.floor((this.height * (1 - 2 * PAD_Y)) / slots);
		this.padY = Math.round((this.height - this.cellH * slots) / 2);
		const blinkOn = now % 1066 < 711;
		const cursorOn = !state.cursorBlink || now % 1066 < 533;
		const cursor = term.cursorOnScreen();
		const glide = state.glide;
		const glideTop = glide ? glide.event.top - term.windowTop : -1;
		const glideBottom = glide ? glide.event.bottom - term.windowTop : -1;
		const sizeKey = `${this.width}x${this.height}:${term.columns}x${slots}:${term.screenReverse}`;
		let changed = glide !== undefined;
		if (this.drawn.length !== slots + 1 || this.drawn[slots] !== sizeKey) {
			this.drawn = new Array(slots + 1).fill("");
			this.drawn[slots] = sizeKey;
			this.ctx.fillStyle = this.background(term.screenReverse);
			this.ctx.fillRect(0, 0, this.width, this.height);
			changed = true;
		}
		for (let row = 0; row < slots; row++) {
			const inGlide = glide !== undefined && row >= glideTop && row <= glideBottom;
			const line = this.lineAt(row, state.indicator);
			const cursorCol = cursor && cursor.row === row && cursorOn ? cursor.col : -1;
			const selected = selectedRange(state.selection, row, line ? lineWidth(line, term.columns) : term.columns);
			const key = inGlide ? "" : rowKey(line, cursorCol, selected, blinkOn, state.cursorStyle);
			if (!inGlide && key === this.drawn[row]) continue;
			this.drawn[row] = key;
			if (inGlide) continue;
			changed = true;
			const y = this.padY + row * this.cellH;
			this.ctx.save();
			this.ctx.beginPath();
			this.ctx.rect(0, y, this.width, this.cellH);
			this.ctx.clip();
			this.paintLine(line, y, cursorCol, selected, blinkOn, state.cursorStyle, row === term.screenLines);
			this.ctx.restore();
		}
		if (glide) this.paintGlide(now, glide, glideTop, glideBottom, cursor, cursorOn, blinkOn, state);
		this.composite(now, changed);
	}

	/**
	 * Onto the tube: what was there fades toward the black of the tube and what is lit now lights it, the brighter of
	 * the two kept, so a dot that goes dark glows a moment longer. Nothing to do once all has faded.
	 */
	private composite(now: number, changed: boolean): void {
		const tau = PERSISTENCE[this.persistence];
		const elapsed = Math.min(100, Math.max(0, now - this.lastComposite));
		this.lastComposite = now;
		if (changed) this.settleUntil = now + tau * 7;
		else if (now > this.settleUntil) return;
		const screen = this.screen;
		if (tau === 0) {
			screen.globalCompositeOperation = "copy";
			screen.drawImage(this.frame, 0, 0);
			screen.globalCompositeOperation = "source-over";
			return;
		}
		screen.globalAlpha = 1 - Math.exp(-elapsed / tau);
		screen.fillStyle = this.background(this.term.screenReverse);
		screen.fillRect(0, 0, this.width, this.height);
		screen.globalAlpha = 1;
		screen.globalCompositeOperation = "lighten";
		screen.drawImage(this.frame, 0, 0);
		screen.globalCompositeOperation = "source-over";
	}

	/** The rows of a scroll part of the way there: one scan line further each step, the lost line going out. */
	private paintGlide(
		now: number,
		glide: Glide,
		top: number,
		bottom: number,
		cursor: { row: number; col: number } | undefined,
		cursorOn: boolean,
		blinkOn: boolean,
		state: FrameState,
	): void {
		const scanLines = this.fontRows();
		const progress = Math.min(1, (now - glide.start) / glide.duration);
		const step = Math.round((1 - progress) * scanLines) / scanLines;
		const offset = step * this.cellH * glide.event.direction;
		const y0 = this.padY + Math.max(0, top) * this.cellH;
		const y1 = this.padY + (Math.min(bottom, this.term.visibleLines - 1) + 1) * this.cellH;
		const ctx = this.ctx;
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, y0, this.width, y1 - y0);
		ctx.clip();
		ctx.fillStyle = this.background(this.term.screenReverse);
		ctx.fillRect(0, y0, this.width, y1 - y0);
		for (let row = top; row <= bottom; row++) {
			const line = this.term.screenLine(row);
			const cursorCol = cursor && cursor.row === row && cursorOn ? cursor.col : -1;
			const selected = selectedRange(state.selection, row, this.term.columns);
			this.paintLine(
				line,
				this.padY + row * this.cellH + offset,
				cursorCol,
				selected,
				blinkOn,
				state.cursorStyle,
				false,
			);
		}
		const lostRow = glide.event.direction === 1 ? top - 1 : bottom + 1;
		this.paintLine(
			glide.event.lost,
			this.padY + lostRow * this.cellH + offset,
			-1,
			undefined,
			blinkOn,
			"block",
			false,
		);
		ctx.restore();
	}

	/** Scan lines a character row has, and so the font it draws with. */
	private fontRows(): Rows {
		const lines = this.term.screenLines;
		return lines === 36 ? 10 : lines === 48 ? 8 : 16;
	}

	/** The tube where nothing is lit: black, the raster glowing more as brightness goes up. */
	private background(reverse: boolean): string {
		if (reverse) return this.color(NORMAL);
		const [r, g, b] = this.phosphor;
		const level = 0.006 + 0.11 * this.knobs.brightness ** 2;
		return `rgb(${Math.round(4 + r * level)} ${Math.round(5 + g * level)} ${Math.round(6 + b * level)})`;
	}

	private color(intensity: number): string {
		const [r, g, b] = this.phosphor;
		// contrast sets the drive and brightness adds to it; no dot is brighter than the phosphor lit full
		const gain = (0.35 + 0.85 * this.knobs.contrast) * (0.85 + 0.3 * this.knobs.brightness);
		const level = Math.min(1, intensity * gain);
		return `rgb(${Math.round(r * level)} ${Math.round(g * level)} ${Math.round(b * level)})`;
	}

	private paintLine(
		line: EmuLine | undefined,
		y: number,
		cursorCol: number,
		selected: [number, number] | undefined,
		blinkOn: boolean,
		cursorStyle: "block" | "underline",
		isStatus: boolean,
	): void {
		const ctx = this.ctx;
		const term = this.term;
		const screenReverse = term.screenReverse && !isStatus;
		ctx.fillStyle = this.background(screenReverse);
		ctx.fillRect(0, y, this.width, this.cellH);
		if (!line) return;
		const double = line.lineAttr !== LINE_SINGLE;
		const width = lineWidth(line, term.columns);
		const pitch = this.cellW * (double ? 2 : 1);
		for (let col = 0; col < width; col++) {
			const char = line.chars[col] ?? " ";
			const attrs = line.attrs[col] ?? 0;
			// whole pixels too, so a run of reverse video has no seams
			const x = Math.round(this.padX + col * pitch);
			const w = Math.round(this.padX + (col + 1) * pitch) - x;
			const isCursor = col === cursorCol;
			const inSelection = selected !== undefined && col >= selected[0] && col <= selected[1];
			let reverse = ((attrs & ATTR_REVERSE) !== 0) !== screenReverse;
			if (inSelection) reverse = !reverse;
			if (isCursor && cursorStyle === "block") reverse = !reverse;
			const intensity = attrs & ATTR_BOLD ? 1 : NORMAL;
			const shown = !(attrs & ATTR_INVISIBLE) && (blinkOn || !(attrs & ATTR_BLINK));
			if (reverse) {
				ctx.fillStyle = this.color(intensity);
				ctx.fillRect(x, y, w, this.cellH);
			}
			const ink = reverse ? this.background(false) : this.color(intensity);
			if (shown && char !== " ") this.glyph(char, attrs >> CODE_SHIFT, x, y, w, line.lineAttr, ink);
			const underline = (shown && attrs & ATTR_UNDERLINE) || (isCursor && cursorStyle === "underline");
			if (underline) {
				ctx.fillStyle = isCursor && cursorStyle === "underline" && !(attrs & ATTR_UNDERLINE) ? this.color(1) : ink;
				// the font's underline scan line, two of them in a double-height line's lower half and none in its upper
				const rows = this.fontRows();
				const tall = line.lineAttr === LINE_DOUBLE_TOP || line.lineAttr === LINE_DOUBLE_BOTTOM;
				const dh = (this.cellH * (tall ? 2 : 1)) / rows;
				const at = (line.lineAttr === LINE_DOUBLE_BOTTOM ? y - this.cellH : y) + UNDERLINE_ROW[rows] * dh;
				if (at >= y && at < y + this.cellH)
					ctx.fillRect(x, Math.round(at), w, Math.round(at + dh) - Math.round(at));
			}
		}
	}

	/** A character in a cell `w` wide and a row high; double-height halves drawn from a glyph two rows high. */
	private glyph(char: string, stored: number, x: number, y: number, w: number, lineAttr: number, ink: string): void {
		const ctx = this.ctx;
		const tall = lineAttr === LINE_DOUBLE_TOP || lineAttr === LINE_DOUBLE_BOTTOM;
		const h = this.cellH * (tall ? 2 : 1);
		const top = lineAttr === LINE_DOUBLE_BOTTOM ? y - this.cellH : y;
		ctx.fillStyle = ink;
		ctx.strokeStyle = ink;
		const soft = this.term.softGlyph(char);
		if (soft) {
			const dotsX = this.term.columns === 132 ? 6 : 10;
			const dotsY = soft.font.lines === 24 ? 16 : soft.font.lines === 36 ? 10 : 8;
			const dw = w / dotsX;
			const dh = h / Math.max(dotsY, soft.font.height);
			const left = soft.font.fullCell ? 0 : Math.floor((dotsX - soft.font.width) / 2);
			soft.rows.forEach((bits, row) => {
				for (let dot = 0; dot < soft.font.width; dot++) {
					if (bits & (1 << dot)) ctx.fillRect(x + (left + dot) * dw, top + row * dh, dw * 1.25, dh);
				}
			});
			return;
		}
		const slot = slotFor(char, stored);
		if (slot !== undefined) {
			this.dots(glyphRows(slot, this.fontRows(), this.term.columns === 132), x, top, w, h);
			return;
		}
		const strokes = STROKES.get(char);
		if (strokes) {
			const thickX = Math.max(1, Math.round(w / 7));
			const thickY = Math.max(1, Math.round(h / 12));
			for (const [x1, y1, x2, y2] of strokes) {
				// a line that stops in the middle reaches over half the other's thickness, so the corner is whole
				if (x1 === x2) {
					const from = Math.min(y1, y2) * h - (Math.min(y1, y2) === 0.5 ? thickY / 2 : 0);
					const to = Math.max(y1, y2) * h + (Math.max(y1, y2) === 0.5 ? thickY / 2 : 0);
					ctx.fillRect(Math.round(x + x1 * w - thickX / 2), top + from, thickX, to - from);
				} else if (y1 === y2) {
					const from = Math.min(x1, x2) * w - (Math.min(x1, x2) === 0.5 ? thickX / 2 : 0);
					const to = Math.max(x1, x2) * w + (Math.max(x1, x2) === 0.5 ? thickX / 2 : 0);
					ctx.fillRect(x + from, Math.round(top + y1 * h - thickY / 2), to - from, thickY);
				} else {
					ctx.lineWidth = (thickX + thickY) / 2;
					ctx.beginPath();
					ctx.moveTo(x + x1 * w, top + y1 * h);
					ctx.lineTo(x + x2 * w, top + y2 * h);
					ctx.stroke();
				}
			}
			return;
		}
		const shape = SHAPES.get(char);
		if (shape) {
			ctx.beginPath();
			for (const [i, [px, py]] of shape.entries()) {
				if (i === 0) ctx.moveTo(x + px * w, top + py * h);
				else ctx.lineTo(x + px * w, top + py * h);
			}
			ctx.closePath();
			ctx.fill();
			return;
		}
		if (SHADES.has(char)) {
			ctx.fillStyle = this.shadePattern(w, h, ink, char);
			ctx.fillRect(x, top, w, h);
			return;
		}
		const picture = PICTURES.get(char);
		if (picture) {
			this.text(picture[0]!, x, top, w * 0.55, h * 0.55);
			this.text(picture[1]!, x + w * 0.45, top + h * 0.45, w * 0.55, h * 0.55);
			return;
		}
		if (char === "⸮") {
			ctx.save();
			ctx.translate(2 * x + w, 0);
			ctx.scale(-1, 1);
			this.text("?", x, top, w, h);
			ctx.restore();
			return;
		}
		this.text(char, x, top, w, h);
	}

	/**
	 * A glyph of the terminal's, a run of lit dots at a time: each dot a scan line high, on whole pixels, and as wide
	 * as the cell's share, a beam's soft edge where that falls between pixels.
	 */
	private dots(rows: number[], x: number, top: number, w: number, h: number): void {
		const ctx = this.ctx;
		const across = this.term.columns === 132 ? 6 : 10;
		const dw = w / across;
		const dh = h / rows.length;
		const spread = STRETCH[this.weight] * dw;
		for (const [row, bits] of rows.entries()) {
			if (bits === 0) continue;
			const y0 = Math.round(top + row * dh);
			const y1 = Math.round(top + (row + 1) * dh);
			let dot = 0;
			while (dot < across) {
				if (!(bits & (1 << dot))) {
					dot++;
					continue;
				}
				let end = dot + 1;
				while (end < across && bits & (1 << end)) end++;
				ctx.fillRect(x + dot * dw, y0, (end - dot) * dw + spread, y1 - y0);
				dot = end;
			}
		}
	}

	/** Text from a font the browser has, its band fitted to the box, for a character the VT420 has no glyph for. */
	private text(char: string, x: number, top: number, w: number, h: number): void {
		const ctx = this.ctx;
		const size = (h * 1000) / (FONT_TOP - FONT_BOTTOM);
		ctx.font = `${size}px VT323, monospace`;
		let advance = this.widths.get(char);
		if (advance === undefined) {
			ctx.font = "100px VT323, monospace";
			advance = ctx.measureText(char).width / 100 || 0.4;
			this.widths.set(char, advance);
			ctx.font = `${size}px VT323, monospace`;
		}
		const scale = Math.min(w / (advance * size), 1.6);
		const baseline = top + (h * FONT_TOP) / (FONT_TOP - FONT_BOTTOM);
		ctx.save();
		ctx.translate(x + (w - advance * size * scale) / 2, baseline);
		ctx.scale(scale, 1);
		ctx.fillText(char, 0, 0);
		// a heavier weight spreads each dot into the next, as a beam driven harder does
		const stretch = STRETCH[this.weight];
		if (stretch > 0) ctx.fillText(char, (w * stretch) / 10 / scale, 0);
		ctx.restore();
	}

	/** A checkerboard of dots, a cell's worth repeated. */
	private shadePattern(w: number, h: number, ink: string, char: string): CanvasPattern | string {
		const key = `${w}:${h}:${ink}:${char}`;
		if (this.shade && this.shadeKey === key) return this.shade;
		const dotsX = this.term.columns === 132 ? 6 : 10;
		const dotsY = 16;
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(w));
		canvas.height = Math.max(1, Math.round(h));
		const ctx = canvas.getContext("2d")!;
		ctx.fillStyle = ink;
		const dw = canvas.width / dotsX;
		const dh = canvas.height / dotsY;
		for (let row = 0; row < dotsY; row++) {
			for (let dot = 0; dot < dotsX; dot++) {
				const on =
					char === "░"
						? row % 2 === 0 && dot % 2 === 0
						: char === "▓"
							? (row + dot) % 2 === 0 || row % 2 === 0
							: (row + dot) % 2 === 0;
				if (on) ctx.fillRect(dot * dw, row * dh, dw, dh);
			}
		}
		const pattern = this.ctx.createPattern(canvas, "repeat");
		if (!pattern) return ink;
		this.shade = pattern;
		this.shadeKey = key;
		return pattern;
	}
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));
}

function lineWidth(line: EmuLine, columns: number): number {
	return line.lineAttr === LINE_SINGLE ? columns : columns >> 1;
}

function rowKey(
	line: EmuLine | undefined,
	cursorCol: number,
	selected: [number, number] | undefined,
	blinkOn: boolean,
	cursorStyle: string,
): RowKey {
	if (!line) return `-${cursorCol}`;
	const blinking = line.attrs.some((attrs) => attrs & ATTR_BLINK);
	return `${line.lineAttr}|${cursorCol}${cursorStyle[0]}|${selected?.join(",") ?? ""}|${blinking && blinkOn ? 1 : 0}|${line.chars.join("")}|${line.attrs.join(",")}`;
}

function selectedRange(selection: Selection | undefined, row: number, width: number): [number, number] | undefined {
	if (!selection) return undefined;
	const { from, to } = selection;
	if (row < from.row || row > to.row) return undefined;
	const start = row === from.row ? from.col : 0;
	const end = row === to.row ? to.col : width - 1;
	return start <= end ? [start, end] : undefined;
}

/** The indicator status line: its text in reverse video across the line. */
function indicatorLine(text: string, columns: number): EmuLine {
	const chars = [...text.padEnd(columns).slice(0, columns)];
	return { chars, attrs: new Array(columns).fill(ATTR_REVERSE), lineAttr: LINE_SINGLE };
}
