/**
 * The screen saver, as in pi-vt420. A CRT left on one picture for hours keeps it in the phosphor, so after a spell
 * without keys the VT420 goes dark while the program runs on: "blank" leaves it so, "progress" shows the program's
 * title and whether its screen still changes, in another place every half minute. Any key brings the screen back and
 * does not reach the program.
 */

import { BLANK, LINE_SINGLE, type Line } from "./vt420/cells.ts";
import type { Frame } from "./vt420/renderer.ts";

export type SaverMode = "off" | "blank" | "progress";

/** Minutes without a key before the screen saver starts. */
export const SAVER_MINUTES = 10;
/** How long the progress line stays in one place. */
export const SAVER_MOVE_MS = 30_000;
/** A screen that changed this recently is busy. */
const BUSY_MS = 10_000;

export function isSaverMode(value: string): value is SaverMode {
	return value === "off" || value === "blank" || value === "progress";
}

/** "busy" while the screen changes, then "quiet 4m" or "quiet 1h 05m". */
export function activity(sinceChange: number): string {
	if (sinceChange < BUSY_MS) return "busy";
	const minutes = Math.floor(sinceChange / 60_000);
	if (minutes < 60) return `quiet ${minutes}m`;
	return `quiet ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A dark screen, with `line` at `place` when there is one. */
export function saverFrame(
	rows: number,
	columns: number,
	line: readonly number[] | undefined,
	place: { row: number; col: number },
	statusLine: boolean,
): Frame {
	const lines: Line[] = Array.from({ length: rows }, () => ({ cells: [], attr: LINE_SINGLE }));
	if (line && place.row < rows) {
		const col = Math.max(0, Math.min(place.col, columns - line.length));
		lines[place.row] = {
			cells: [...new Array<number>(col).fill(BLANK), ...line.slice(0, columns)],
			attr: LINE_SINGLE,
		};
	}
	return { lines, status: statusLine ? [] : undefined, scroll: { top: 0, bottom: rows - 1 } };
}

/** Anywhere a line of `length` cells fits. */
export function saverPlace(
	rows: number,
	columns: number,
	length: number,
	random: () => number = Math.random,
): { row: number; col: number } {
	return {
		row: Math.floor(random() * rows),
		col: Math.floor(random() * Math.max(1, columns - length + 1)),
	};
}
