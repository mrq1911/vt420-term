import { describe, expect, it } from "vitest";
import { ATTR_REVERSE, LINE_SINGLE, type Line } from "../src/vt420/cells.ts";
import { Charset } from "../src/vt420/charset.ts";
import { type Frame, Renderer } from "../src/vt420/renderer.ts";
import { charsetDesignations, SESSION_MODES } from "../src/vt420/sequences.ts";
import { cellsText, Vt420Emulator } from "./emulator.ts";
import { vt420Violations } from "./safety.ts";

const ROWS = 12;
const COLUMNS = 40;
const DESIGNATIONS = charsetDesignations({ technical: true, supplemental: "dec", eightBit: false });
const charset = new Charset({ technical: true, supplemental: "dec", eightBit: false });

function setup(leftRightMargins: boolean) {
	const renderer = new Renderer({
		rows: ROWS,
		columns: COLUMNS,
		statusLine: false,
		rectangularOps: true,
		eraseCharacters: true,
		eightBit: false,
		leftRightMargins,
		designations: DESIGNATIONS,
	});
	const emulator = new Vt420Emulator({ rows: ROWS, columns: COLUMNS });
	emulator.feed(SESSION_MODES + DESIGNATIONS);
	const sent: string[] = [];
	const draw = (frame: Frame): string => {
		const bytes = renderer.render(frame);
		sent.push(bytes);
		emulator.feed(Buffer.from(bytes, "latin1"));
		return bytes;
	};
	return { emulator, draw, sent };
}

/** Two panes side by side, split by a line-drawing border, as a multiplexer draws them. */
function panes(left: readonly string[], right: readonly string[], reversed = -1): Frame {
	const lines: Line[] = [];
	for (let row = 0; row < ROWS; row++) {
		const text = `${(left[row] ?? "").padEnd(19).slice(0, 19)}│${(right[row] ?? "").padEnd(20).slice(0, 20)}`;
		const cells = charset.cells(text);
		lines.push({ cells: row === reversed ? cells.map((cell) => cell | ATTR_REVERSE) : cells, attr: LINE_SINGLE });
	}
	return { lines, scroll: { top: 0, bottom: ROWS - 1 } };
}

function expectShown(emulator: Vt420Emulator, frame: Frame): void {
	frame.lines.forEach((line, row) => {
		expect(emulator.text(row), `row ${row}`).toBe(cellsText(line.cells).replace(/\s+$/u, ""));
		line.cells.forEach((cell, col) => {
			expect((emulator.attrsAt(row, col) & 8) !== 0, `reverse at ${row}:${col}`).toBe((cell & ATTR_REVERSE) !== 0);
		});
	});
}

describe("rectangle scrolling", () => {
	it("scrolls one pane among others inside margins, for a fraction of the bytes", () => {
		// varied lines, as a real log has; lines that differ only in a digit are cheaper to rewrite than to scroll
		const events = ["open config", "read 4 files", "connect db", "listen :8080", "GET /", "200 in 3ms", "worker up"];
		const log = Array.from({ length: 40 }, (_, index) => `${index} ${events[(index * 3) % events.length]}`);
		const editor = ["fn main() {", "    let x = 1;", "    run(x);", "}"];
		const totals: number[] = [];
		for (const margins of [true, false]) {
			const s = setup(margins);
			s.draw(panes(editor, log.slice(0, ROWS)));
			let total = 0;
			for (let step = 1; step <= 10; step++) {
				const frame = panes(editor, log.slice(step, step + ROWS));
				const bytes = s.draw(frame);
				total += bytes.length;
				expectShown(s.emulator, frame);
				if (margins) {
					// left and right margins inside the right pane only, as far as its text reaches
					const margins = /\x1b\[21;(\d+)s/.exec(bytes);
					expect(Number(margins?.[1])).toBeGreaterThan(21);
					expect(Number(margins?.[1])).toBeLessThanOrEqual(40);
					expect(bytes).toContain("\x1bD");
					expect(bytes.length).toBeLessThan(70);
				}
			}
			totals.push(total);
			expect(vt420Violations(Buffer.from(s.sent.join(""), "latin1"))).toEqual([]);
		}
		expect(totals[0]!).toBeLessThan(totals[1]! * 0.75);
	});

	it("saves the most when lines fill a pane whose neighbour is full too", () => {
		const filler = "abcdefghijklmnopqrstuvwxyz";
		const log = Array.from({ length: 40 }, (_, index) => `${index} ${filler.slice(index % 7)}${filler}`.slice(0, 20));
		// with text on every row of the other pane, whole rows never move, and only margins can scroll
		const source = Array.from({ length: ROWS }, (_, index) => `${index + 1}  let value${index} = ${index * 7};`);
		const totals: number[] = [];
		for (const margins of [true, false]) {
			const s = setup(margins);
			s.draw(panes(source, log.slice(0, ROWS)));
			let total = 0;
			for (let step = 1; step <= 10; step++) {
				const frame = panes(source, log.slice(step, step + ROWS));
				total += s.draw(frame).length;
				expectShown(s.emulator, frame);
			}
			totals.push(total);
		}
		expect(totals[0]! * 4).toBeLessThan(totals[1]!);
	});

	it("keeps the screen exact while both panes scroll either way and change", () => {
		let seed = 11;
		const random = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const words = ["alpha", "beta", "│", "─┼─", "gamma", "π", "≥", "ü", "  ", "delta"];
		const line = (): string =>
			Array.from({ length: 1 + Math.floor(random() * 4) }, () => words[Math.floor(random() * words.length)]).join(
				" ",
			);
		const left = Array.from({ length: ROWS }, line);
		const right = Array.from({ length: ROWS }, line);
		const s = setup(true);
		let scrolled = 0;
		for (let step = 0; step < 150; step++) {
			for (const pane of [left, right]) {
				const action = random();
				const amount = 1 + Math.floor(random() * 3);
				if (action < 0.35) {
					pane.splice(0, amount);
					for (let i = 0; i < amount; i++) pane.push(line());
				} else if (action < 0.5) {
					pane.splice(pane.length - amount, amount);
					for (let i = 0; i < amount; i++) pane.unshift(line());
				} else if (action < 0.7) {
					pane[Math.floor(random() * pane.length)] = line();
				}
			}
			const frame = panes(left, right, random() < 0.2 ? Math.floor(random() * ROWS) : -1);
			if (/\x1b\[\d+;\d+s/.test(s.draw(frame))) scrolled++;
			expectShown(s.emulator, frame);
		}
		expect(scrolled).toBeGreaterThan(20);
		expect(vt420Violations(Buffer.from(s.sent.join(""), "latin1"))).toEqual([]);
	});
});
