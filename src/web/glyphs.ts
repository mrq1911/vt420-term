/**
 * Characters drawn rather than taken from the font: the line-drawing and scan-line characters and the pieces of
 * the DEC Technical set's large symbols, which have to meet their neighbours' edges exactly, and a few others.
 * Coordinates are in a unit cell, x to the right and y down.
 */

export type Segment = readonly [number, number, number, number];

const H = 0.5;
const SCAN = (n: number): number => (n - 0.5) / 9;

export const STROKES: ReadonlyMap<string, readonly Segment[]> = new Map<string, readonly Segment[]>([
	["─", [[0, H, 1, H]]],
	["│", [[H, 0, H, 1]]],
	[
		"┌",
		[
			[H, H, 1, H],
			[H, H, H, 1],
		],
	],
	[
		"┐",
		[
			[0, H, H, H],
			[H, H, H, 1],
		],
	],
	[
		"└",
		[
			[H, 0, H, H],
			[H, H, 1, H],
		],
	],
	[
		"┘",
		[
			[H, 0, H, H],
			[0, H, H, H],
		],
	],
	[
		"├",
		[
			[H, 0, H, 1],
			[H, H, 1, H],
		],
	],
	[
		"┤",
		[
			[H, 0, H, 1],
			[0, H, H, H],
		],
	],
	[
		"┬",
		[
			[0, H, 1, H],
			[H, H, H, 1],
		],
	],
	[
		"┴",
		[
			[0, H, 1, H],
			[H, 0, H, H],
		],
	],
	[
		"┼",
		[
			[0, H, 1, H],
			[H, 0, H, 1],
		],
	],
	// scan lines 1, 3, 7 and 9 of DEC Special Graphics; 5 is the horizontal line
	["⎺", [[0, SCAN(1), 1, SCAN(1)]]],
	["⎻", [[0, SCAN(3), 1, SCAN(3)]]],
	["⎼", [[0, SCAN(7), 1, SCAN(7)]]],
	["⎽", [[0, SCAN(9), 1, SCAN(9)]]],
	// DEC Technical: the radical, integral, bracket, brace and summation pieces
	[
		"⎷",
		[
			[0.15, 0.62, 0.3, 0.52],
			[0.3, 0.52, H, 1],
			[H, 1, H, 0],
		],
	],
	[
		"⌠",
		[
			[H, 1, H, 0.22],
			[H, 0.22, 0.62, 0.06],
			[0.62, 0.06, 0.8, 0.04],
		],
	],
	[
		"⌡",
		[
			[H, 0, H, 0.78],
			[H, 0.78, 0.38, 0.94],
			[0.38, 0.94, 0.2, 0.96],
		],
	],
	[
		"⎡",
		[
			[0.4, 0.04, 0.85, 0.04],
			[0.4, 0.04, 0.4, 1],
		],
	],
	[
		"⎣",
		[
			[0.4, 0, 0.4, 0.96],
			[0.4, 0.96, 0.85, 0.96],
		],
	],
	[
		"⎤",
		[
			[0.15, 0.04, 0.6, 0.04],
			[0.6, 0.04, 0.6, 1],
		],
	],
	[
		"⎦",
		[
			[0.6, 0, 0.6, 0.96],
			[0.15, 0.96, 0.6, 0.96],
		],
	],
	[
		"⎧",
		[
			[H, 1, H, 0.25],
			[H, 0.25, 0.8, 0.04],
		],
	],
	[
		"⎩",
		[
			[H, 0, H, 0.75],
			[H, 0.75, 0.8, 0.96],
		],
	],
	[
		"⎫",
		[
			[H, 1, H, 0.25],
			[H, 0.25, 0.2, 0.04],
		],
	],
	[
		"⎭",
		[
			[H, 0, H, 0.75],
			[H, 0.75, 0.2, 0.96],
		],
	],
	[
		"⎨",
		[
			[H, 0, H, 0.4],
			[H, 0.4, 0.2, H],
			[0.2, H, H, 0.6],
			[H, 0.6, H, 1],
		],
	],
	[
		"⎬",
		[
			[H, 0, H, 0.4],
			[H, 0.4, 0.8, H],
			[0.8, H, H, 0.6],
			[H, 0.6, H, 1],
		],
	],
	[
		"⎲",
		[
			[0.2, 0.04, 1, 0.04],
			[0.2, 0.04, 1, 1],
		],
	],
	[
		"⎳",
		[
			[0.2, 0.96, 1, 0.96],
			[0.2, 0.96, 1, 0],
		],
	],
	["╲", [[0, 0, 1, 1]]],
	["╱", [[0, 1, 1, 0]]],
	[
		"⌝",
		[
			[0, 0.04, 0.7, 0.04],
			[0.7, 0.04, 0.7, 0.3],
		],
	],
	[
		"⌟",
		[
			[0, 0.96, 0.7, 0.96],
			[0.7, 0.96, 0.7, 0.7],
		],
	],
	[
		"⟩",
		[
			[0, 0, 0.6, H],
			[0.6, H, 0, 1],
		],
	],
]);

/** The control pictures of DEC Special Graphics: two small letters on the diagonal. */
export const PICTURES: ReadonlyMap<string, string> = new Map([
	["␉", "HT"],
	["␌", "FF"],
	["␍", "CR"],
	["␊", "LF"],
	["␤", "NL"],
	["␋", "VT"],
]);

/** Filled shapes, as polygons. */
export const SHAPES: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>> = new Map<
	string,
	ReadonlyArray<readonly [number, number]>
>([
	[
		"◆",
		[
			[0.5, 0.22],
			[0.88, 0.5],
			[0.5, 0.78],
			[0.12, 0.5],
		],
	],
	[
		"█",
		[
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		],
	],
	[
		"▀",
		[
			[0, 0],
			[1, 0],
			[1, 0.5],
			[0, 0.5],
		],
	],
	[
		"▄",
		[
			[0, 0.5],
			[1, 0.5],
			[1, 1],
			[0, 1],
		],
	],
	[
		"▌",
		[
			[0, 0],
			[0.5, 0],
			[0.5, 1],
			[0, 1],
		],
	],
	[
		"▐",
		[
			[0.5, 0],
			[1, 0],
			[1, 1],
			[0.5, 1],
		],
	],
]);

/** Checkerboards, by how much of the cell they light. */
export const SHADES: ReadonlySet<string> = new Set(["▒", "░", "▓"]);
