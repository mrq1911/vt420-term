/**
 * What vt420-probe asks a real VT420, and the conformance test asks vt420's: each case is sent after the terminal
 * is put in a known state, then questions whose answers say what it did (where the cursor went, checksums of the
 * screen, modes). Cases go where the reference leaves room or emulators disagree.
 */

export interface ProbeCase {
	name: string;
	send: string;
	/** Asked one at a time, each answer recorded. */
	ask: string[];
	/** Sent after the questions, to put back what the case changed outside page memory. */
	after?: string;
}

/** The known state each case starts from: a soft reset, no margins, jump scroll, autowrap, a clear page 1. */
export const START = "\x1b[!p\x1b[?69l\x1b[?4l\x1b[?7h\x1b[1 P\x1b[r\x1b[H\x1b[2J";

const CURSOR = "\x1b[?6n";
const check = (top: number, left: number, bottom = top, right = left, page = 1): string =>
	`\x1b[1;${page};${top};${left};${bottom};${right}*y`;
const mode = (number: number): string => `\x1b[?${number}$p`;

export const CASES: readonly ProbeCase[] = [
	// how DECRQCRA sums a cell, so that the other checksums mean something
	{ name: "checksum of a blank cell", send: "", ask: [check(1, 1)] },
	{ name: "checksum of A", send: "A", ask: [check(1, 1)] },
	{ name: "checksum of bold A", send: "\x1b[1mA", ask: [check(1, 1)] },
	{ name: "checksum of underlined A", send: "\x1b[4mA", ask: [check(1, 1)] },
	{ name: "checksum of blinking A", send: "\x1b[5mA", ask: [check(1, 1)] },
	{ name: "checksum of reverse A", send: "\x1b[7mA", ask: [check(1, 1)] },
	{ name: "checksum of invisible A", send: "\x1b[8mA", ask: [check(1, 1)] },
	{ name: "checksum of protected A", send: '\x1b[1"qA', ask: [check(1, 1)] },
	{ name: "checksum of reverse blank", send: "\x1b[7m ", ask: [check(1, 1)] },
	{ name: "checksum of a line-drawing character", send: "\x1b(0q\x1b(B", ask: [check(1, 1)] },
	{ name: "checksum of a Technical character", send: "\x1b*>\x1bNa", ask: [check(1, 1)] },
	{ name: "checksum of a supplemental character", send: "\xe9", ask: [check(1, 1)] },
	{ name: "checksum of two rows", send: "AB\r\nCD", ask: [check(1, 1, 2, 2)] },
	// the cursor
	{ name: "backspace after the last column", send: `\x1b[1;80Hx\b`, ask: [CURSOR] },
	{ name: "wrap to the next line", send: `\x1b[1;80Hxy`, ask: [CURSOR, check(2, 1)] },
	{ name: "carriage return after the last column", send: `\x1b[1;80Hx\ry`, ask: [CURSOR, check(1, 1)] },
	{ name: "no autowrap overwrites the last column", send: `\x1b[?7l\x1b[1;79Hxyz`, ask: [CURSOR, check(1, 80)] },
	{ name: "cursor up from below the bottom margin", send: "\x1b[5;10r\x1b[15;1H\x1b[20A", ask: [CURSOR] },
	{ name: "cursor down from above the top margin", send: "\x1b[5;10r\x1b[2;1H\x1b[20B", ask: [CURSOR] },
	{ name: "cursor up inside the margins", send: "\x1b[5;10r\x1b[8;1H\x1b[20A", ask: [CURSOR] },
	{ name: "cursor position report in origin mode", send: "\x1b[5;10r\x1b[?6h\x1b[2;3H", ask: ["\x1b[6n", CURSOR] },
	{ name: "cursor forward past the right margin", send: "\x1b[?69h\x1b[5;20s\x1b[1;10H\x1b[50C", ask: [CURSOR] },
	{ name: "cursor forward outside the margins", send: "\x1b[?69h\x1b[5;20s\x1b[1;30H\x1b[90C", ask: [CURSOR] },
	{ name: "cursor back at the left margin", send: "\x1b[?69h\x1b[5;20s\x1b[1;5H\x1b[3D", ask: [CURSOR] },
	{ name: "backspace at the left margin", send: "\x1b[?69h\x1b[5;20s\x1b[1;5H\b", ask: [CURSOR] },
	{ name: "carriage return outside the margins", send: "\x1b[?69h\x1b[5;20s\x1b[1;3H\r", ask: [CURSOR] },
	{ name: "where DECSLRM puts the cursor", send: "\x1b[3;3H\x1b[?69h\x1b[5;20s", ask: [CURSOR] },
	{ name: "where DECSTBM puts the cursor", send: "\x1b[3;3H\x1b[5;10r", ask: [CURSOR] },
	{ name: "tab to the end of the line", send: "\x1b[1;75H\t\t", ask: [CURSOR] },
	// a soft reset keeps them, whatever programs set before
	{ name: "tab stops a soft reset keeps", send: "", ask: ["\x1b[2$w"] },
	// editing
	{ name: "where insert line leaves the cursor", send: "\x1b[5;10H\x1b[L", ask: [CURSOR] },
	{ name: "where delete line leaves the cursor", send: "\x1b[5;10H\x1b[M", ask: [CURSOR] },
	{ name: "insert line below the bottom margin", send: "\x1b[5;10r\x1b[15;1Hx\x1b[L", ask: [CURSOR, check(15, 1)] },
	{
		name: "insert character pushes off the right margin",
		send: "\x1b[1;79Hab\x1b[1;79H\x1b[@",
		ask: [check(1, 79, 1, 80)],
	},
	{ name: "delete character in insert mode", send: "abcdef\x1b[1;2H\x1b[4h\x1b[2P\x1b[4l", ask: [check(1, 1, 1, 6)] },
	{
		name: "insert mode at the last column",
		send: "\x1b[1;79Hab\x1b[1;80H\x1b[4hX\x1b[4l",
		ask: [CURSOR, check(1, 79, 1, 80)],
	},
	{
		name: "erase below from column 1 of a double-width line",
		send: "\x1b[3;1H\x1b#6x\x1b[3;1H\x1b[J\x1b[3;999H",
		ask: [CURSOR],
	},
	{ name: "erase a double-width line", send: "\x1b[3;1H\x1b#6x\x1b[2K\x1b[3;999H", ask: [CURSOR] },
	{ name: "double width, then the cursor far right", send: "\x1b[2;1H\x1b#6\x1b[2;999H", ask: [CURSOR] },
	{ name: "double width keeps the left half", send: `\x1b[2;1H${"y".repeat(60)}\x1b#6`, ask: [check(2, 1, 2, 80)] },
	{ name: "selective erase keeps the protected", send: 'a\x1b[1"qb\x1b[0"qc\x1b[?2K', ask: [check(1, 1, 1, 3)] },
	{ name: "selective erase keeps attributes", send: "\x1b[1mabc\x1b[m\x1b[?2K", ask: [check(1, 1, 1, 3)] },
	{ name: "erase character clears attributes", send: "\x1b[7mabc\x1b[m\x1b[1;1H\x1b[2X", ask: [check(1, 1, 1, 3)] },
	// rectangles
	{ name: "fill with a line-drawing character", send: "\x1b(0\x1b[113;1;1;1;5$x\x1b(B", ask: [check(1, 1, 1, 5)] },
	{ name: "fill takes the rendition", send: "\x1b[1;4m\x1b[65;1;1;1;3$x", ask: [check(1, 1, 1, 3)] },
	{
		name: "copy to another page",
		send: "hello\x1b[1;1;1;5;1;3;3;2$v",
		ask: [check(3, 3, 3, 7, 2)],
		after: "\x1b[2 P\x1b[2J\x1b[1 P",
	},
	{
		name: "reverse attributes over a stream of positions",
		send: "\x1b[1;70;2;5;5$t",
		ask: [check(1, 80), check(2, 1), check(2, 6), check(1, 69)],
	},
	{
		name: "reverse attributes over a stream of written positions",
		send: `\x1b[1*x\x1b[1;70H${"x".repeat(11)}\x1b[2;1H${"x".repeat(6)}\x1b[1;70;2;5;5$t`,
		ask: [check(1, 69), check(1, 70), check(1, 80), check(2, 1), check(2, 5), check(2, 6)],
	},
	{
		name: "reverse attributes over a stream, left before right",
		send: `\x1b[1*x\x1b[1;1H${"x".repeat(80)}${"x".repeat(6)}\x1b[1;3;2;5;5$t`,
		ask: [check(1, 2), check(1, 3), check(1, 80), check(2, 5), check(2, 6), check(2, 1)],
	},
	{
		name: "change attributes in a rectangle",
		send: "\x1b[2*x\x1b[1;70;2;75;1$r",
		ask: [check(1, 69), check(1, 72), check(2, 72)],
	},
	{
		name: "erase a rectangle keeps line attributes",
		send: "\x1b[2;1H\x1b#6ab\x1b[2;1;2;80$z\x1b[2;999H",
		ask: [CURSOR],
	},
	// character sets and controls
	{ name: "SUB shows the error character", send: "a\x1ab", ask: [CURSOR, check(1, 2)] },
	{ name: "CAN shows nothing", send: "a\x18b", ask: [CURSOR] },
	{ name: "BEL does not end an OSC string", send: "\x1b]0;x\x07y\x1b\\z", ask: [CURSOR, check(1, 1)] },
	{ name: "a C1 control ends an OSC string", send: "\x1b]0;x\x1b[Cz", ask: [CURSOR] },
	{ name: "DEL with a 94-character set", send: "a\x7fb", ask: [CURSOR] },
	{ name: "single shift for one character", send: "\x1b*0\x1bNqq", ask: [check(1, 1), check(1, 2)] },
	{ name: "GR 0xA0 with DEC Supplemental", send: "\xa0", ask: [CURSOR, check(1, 1)] },
	{ name: "GR 0xFF with DEC Supplemental", send: "\xff", ask: [CURSOR] },
	{ name: "colour by numbers: 38;5;n", send: "\x1b[38;5;1mA", ask: [check(1, 1)] },
	{ name: "unknown CSI final", send: "\x1b[5Gx", ask: [CURSOR] },
	{ name: "cursor information after shifts", send: "\x1b)0\x1b*>\x1b+%5\x1b~\x1bn\x1b[1;5m", ask: ["\x1b[1$w"] },
	// resets and modes
	{ name: "soft reset turns autowrap off", send: "\x1b[?7h\x1b[!p", ask: [mode(7)] },
	{ name: "soft reset and the cursor's visibility", send: "\x1b[?25l\x1b[!p", ask: [mode(25)] },
	{ name: "soft reset and smooth scroll", send: "\x1b[?4h\x1b[!p", ask: [mode(4)], after: "\x1b[?4l" },
	{ name: "soft reset and insert mode", send: "\x1b[4h\x1b[!p", ask: ["\x1b[4$p"] },
	{ name: "restore cursor with nothing saved", send: "\x1b[5;5H\x1b[1m\x1b[?6h\x1b8", ask: [CURSOR, "\x1b[1$w"] },
	{ name: "screen alignment and the margins", send: "\x1b[5;10r\x1b#8", ask: ["\x1bP$qr\x1b\\", CURSOR, check(1, 1)] },
	{
		name: "48 lines on pages of 24",
		send: "\x1b[48*|",
		ask: ['\x1b["v', "\x1b[30;1H\x1b[?6n"],
		after: "\x1b[24*|",
	},
	{
		name: "the status line, written past its end",
		send: `\x1b[2$~\x1b[1$}${"x".repeat(85)}`,
		ask: [CURSOR, "\x1b[6n"],
		after: "\x1b[2K\x1b[0$}",
	},
	{ name: "a valid DECRQSS", send: "\x1b[1m", ask: ["\x1bP$qm\x1b\\"] },
	{ name: "an invalid DECRQSS", send: "", ask: ["\x1bP$qz\x1b\\"] },
	{ name: "an unknown DEC mode", send: "", ask: [mode(999)] },
	{ name: "a permanently reset ANSI mode", send: "", ask: ["\x1b[1$p"] },
];

/** Modes and settings recorded before the cases, so that the test can set vt420 up the same. */
export const MODES = [1, 3, 4, 5, 6, 7, 8, 25, 42, 60, 61, 64, 66, 67, 68, 69, 73, 81];
export const ANSI_MODES = [2, 3, 4, 12, 20];
export const SETTINGS = ["m", "r", "s", "t", "$|", "*|", '"p', '"q', "$}", "$~", "*x", "+q", "*}", "+r"];
/** Reports to keep as they are; DA3 (the unit's serial number) and ENQ (the answerback) are left out. */
export const REPORTS = [
	"\x1b[c",
	"\x1b[>c",
	"\x1b[5n",
	"\x1b[?15n",
	"\x1b[?25n",
	"\x1b[?26n",
	"\x1b[?62n",
	"\x1b[?75n",
	"\x1b[?85n",
	"\x1b[&u",
	'\x1b["v',
	"\x1b[1$u",
	"\x1b[1$w",
	"\x1b[2$w",
];
