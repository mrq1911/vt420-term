import { describe, expect, it } from "vitest";
import { keyBytes, pastedBytes } from "../src/emu/keyboard.ts";
import {
	ATTR_BLINK,
	ATTR_BOLD,
	ATTR_REVERSE,
	ATTR_UNDERLINE,
	LINE_DOUBLE_WIDTH,
	Vt420,
	type Vt420Options,
} from "../src/emu/vt420.ts";

function terminal(options: Vt420Options = {}): { term: Vt420; answers: string[] } {
	const answers: string[] = [];
	const term = new Vt420({ ...options, onResponse: (bytes) => answers.push(bytes) });
	return { term, answers };
}

/** Feed, then the answers since. */
function ask(term: Vt420, answers: string[], bytes: string): string {
	answers.length = 0;
	term.feed(bytes);
	return answers.join("");
}

describe("parser", () => {
	it("acts on C0 controls inside a sequence and cancels with CAN and SUB", () => {
		const { term } = terminal();
		term.feed("ab\x1b[\r2Cc");
		expect(term.text(0)).toBe("abc");
		term.feed("\r\nx\x1b[1\x18y");
		expect(term.text(1)).toBe("xy");
		term.feed("\r\nq\x1b[3\x1az");
		expect(term.text(2)).toBe("q⸮z");
	});

	it("ignores an OSC string until ST, whatever BEL", () => {
		const { term } = terminal();
		term.feed("\x1b]0;title\x07still title\x1b\\shown");
		expect(term.text(0)).toBe("shown");
	});

	it("takes 8-bit C1 controls, and GR characters from the supplemental set", () => {
		const { term } = terminal();
		term.feed("\x9b5Cx\xe9\xc4");
		expect(term.text(0)).toBe("     xéÄ");
	});

	it("decodes UTF-8 when told to, as a modern emulator", () => {
		const { term } = terminal({ utf8: true });
		term.feed(Buffer.from("π ≥ é", "utf8"));
		expect(term.text(0)).toBe("π ≥ é");
	});
});

describe("writing", () => {
	it("wraps at the last column only when the next character comes", () => {
		const { term } = terminal({ setup: { columns: 80 } });
		term.feed(`${"x".repeat(80)}`);
		expect([term.row, term.col, term.pendingWrap]).toEqual([0, 79, true]);
		term.feed("y");
		expect(term.text(1)).toBe("y");
		term.feed("\x1b[?7l\x1b[3;1H");
		term.feed("z".repeat(85));
		expect(term.text(2)).toBe("z".repeat(80));
		expect(term.text(3)).toBe("");
	});

	it("inserts in insert mode, losing what passes the right border", () => {
		const { term } = terminal();
		term.feed("abc\r\x1b[4hXY\x1b[4l");
		expect(term.text(0)).toBe("XYabc");
	});

	it("draws DEC Special Graphics, Technical and single shifts", () => {
		const { term } = terminal();
		term.feed("\x1b(0lqk\x1b(B \x1b*>\x1bNa\x1bO\xe4 \x1b+0\x1bo`\x0f");
		expect(term.text(0)).toBe("┌─┐ αä ◆");
	});

	it("uses a national set in national mode only", () => {
		const { term } = terminal({ setup: { nationalSet: "german" } });
		term.feed("\x1b(K[]");
		expect(term.text(0)).toBe("[]");
		term.feed("\x1b[?42h\x1b(K\r[]{}~");
		expect(term.text(0)).toBe("ÄÜäüß");
	});

	it("loads a soft font and draws from it once designated", () => {
		const { term } = terminal();
		// DECDLD: one 80x24 text character at 0x21, named @ with an intermediate space
		term.feed("\x1bP1;1;1;0;0;0;0;0{ @~~~~/~~~~/????\x1b\\");
		term.feed("\x1b( @!\x1b(B");
		const char = term.lines[0]!.chars[0]!;
		const glyph = term.softGlyph(char);
		expect(glyph?.font.name).toBe(" @");
		expect(glyph?.rows.slice(0, 13)).toEqual([...new Array(12).fill(0b1111), 0]);
	});
});

describe("line attributes and margins", () => {
	it("halves a line made double width, and refuses it with left and right margins", () => {
		const { term } = terminal();
		term.feed(`${"x".repeat(60)}\r\x1b#6`);
		expect(term.lineAttr(0)).toBe(LINE_DOUBLE_WIDTH);
		expect(term.text(0)).toBe("x".repeat(40));
		term.feed("\x1b[?69h\x1b[2H\x1b#6");
		expect(term.lineAttr(1)).toBe(0);
		expect(term.lineAttr(0)).toBe(0);
	});

	it("scrolls between the margins, and a rectangle with left and right ones", () => {
		const { term } = terminal();
		for (let row = 1; row <= 5; row++) term.feed(`\x1b[${row}H${row}${row}${row}${row}`);
		term.feed("\x1b[2;4r\x1b[4H\n");
		expect(term.screen().slice(0, 5)).toEqual(["1111", "3333", "4444", "", "5555"]);
		term.feed("\x1b[r\x1b[?69h\x1b[2;3s\x1b[1;5r\x1b[5;2H\x1bD");
		expect(term.screen().slice(0, 5)).toEqual(["1331", "3443", "4  4", " 55", "5  5"]);
	});

	it("stops cursor movement at the margins it starts inside", () => {
		const { term } = terminal();
		term.feed("\x1b[5;10r\x1b[7H\x1b[20A");
		expect(term.row).toBe(4);
		term.feed("\x1b[2H\x1b[30B");
		expect(term.row).toBe(9);
		term.feed("\x1b[12H\x1b[30B");
		expect(term.row).toBe(23);
	});

	it("addresses within the margins in origin mode, and reports so", () => {
		const { term, answers } = terminal();
		term.feed("\x1b[5;10r\x1b[?6h\x1b[2;3H");
		expect([term.row, term.col]).toEqual([5, 2]);
		expect(ask(term, answers, "\x1b[6n")).toBe("\x1b[2;3R");
	});
});

describe("editing", () => {
	it("inserts and deletes characters, lines and columns", () => {
		const { term } = terminal();
		term.feed("abcdef\x1b[1;3H\x1b[2@");
		expect(term.text(0)).toBe("ab  cdef");
		term.feed("\x1b[3P");
		expect(term.text(0)).toBe("abdef");
		term.feed("\x1b[2;1Hsecond\x1b[3;1Hthird\x1b[2;1H\x1b[L");
		expect(term.screen().slice(0, 4)).toEqual(["abdef", "", "second", "third"]);
		term.feed("\x1b[2M");
		expect(term.screen().slice(0, 3)).toEqual(["abdef", "third", ""]);
		term.feed("\x1b[1;2H\x1b[2'}");
		expect(term.screen().slice(0, 2)).toEqual(["a  bdef", "t  hird"]);
		term.feed("\x1b[1'~");
		expect(term.screen().slice(0, 2)).toEqual(["a bdef", "t hird"]);
	});

	it("erases selectively only what DECSCA left unprotected", () => {
		const { term } = terminal();
		term.feed('keep\x1b[1"qSAFE\x1b[0"qgone\x1b[?2K');
		expect(term.text(0)).toBe("    SAFE");
		term.feed("\x1b[2K");
		expect(term.text(0)).toBe("");
	});
});

describe("rectangles", () => {
	it("copies between pages, fills, erases and changes attributes", () => {
		const { term } = terminal();
		term.feed("\x1b[1;1Habcd\x1b[2;1Hefgh");
		term.feed("\x1b[1;2;2;3;1;3;5;2$v");
		term.feed("\x1b[2 P");
		expect(term.screen().slice(2, 4)).toEqual(["    bc", "    fg"]);
		term.feed("\x1b[1 P\x1b[42;5;1;6;3$x");
		expect(term.screen().slice(4, 6)).toEqual(["***", "***"]);
		term.feed("\x1b[5;2;6;2$z");
		expect(term.screen().slice(4, 6)).toEqual(["* *", "* *"]);
		term.feed("\x1b[2*x\x1b[5;1;6;1;1;4$r");
		expect(term.attrsAt(5, 0)).toBe(ATTR_BOLD | ATTR_UNDERLINE);
		expect(term.attrsAt(5, 2)).toBe(0);
		term.feed("\x1b[5;1;5;3;7$t");
		expect(term.attrsAt(4, 2)).toBe(ATTR_REVERSE);
	});

	it("changes the stream of positions between the corners, not the rectangle, by default", () => {
		const { term } = terminal({ setup: { columns: 80 } });
		term.feed("\x1b[1;70;2;5;5$r");
		expect(term.attrsAt(0, 79)).toBe(ATTR_BLINK);
		expect(term.attrsAt(1, 0)).toBe(ATTR_BLINK);
		expect(term.attrsAt(1, 5)).toBe(0);
	});
});

describe("pages and the status line", () => {
	it("moves between pages, with the display coupled or not", () => {
		const { term } = terminal();
		term.feed("one\x1b[U");
		expect([term.page, term.displayPage, term.row, term.col]).toEqual([1, 1, 0, 0]);
		term.feed("\x1b[3;4H\x1b[2 Q");
		expect([term.page, term.row, term.col]).toEqual([3, 2, 3]);
		term.feed("\x1b[?64l\x1b[1 P");
		expect([term.page, term.displayPage]).toEqual([0, 3]);
		expect(term.cursorOnScreen()).toBeUndefined();
	});

	it("writes the host-writable status line, apart from the main display", () => {
		const { term } = terminal();
		term.feed("\x1b[1;1Hmain\x1b[2$~\x1b[1$}\x1b[1mstatus\x1b[0$}x");
		expect(term.statusText()).toBe("status");
		expect(term.text(0)).toBe("mainx");
		expect(term.attrsAt(0, 4)).toBe(0);
		expect(term.status.attrs[0]).toBe(ATTR_BOLD);
	});

	it("keeps a page longer than the screen, panning to the cursor", () => {
		const { term } = terminal();
		term.feed("\x1b[72t\x1b[50;1Hdeep");
		expect(term.pageCount).toBe(2);
		expect(term.windowTop).toBe(50 - 24 + 0);
		term.feed("\x1b[5T");
		expect(term.windowTop).toBe(21);
	});
});

describe("reports", () => {
	it("answers as a VT420 does", () => {
		const { term, answers } = terminal();
		expect(ask(term, answers, "\x1b[c")).toBe("\x1b[?64;1;2;6;7;8;9;15;18;19;21c");
		expect(ask(term, answers, "\x1b[>c")).toBe("\x1b[>41;10;0c");
		expect(ask(term, answers, "\x1b[=c")).toBe("\x1bP!|00000000\x1b\\");
		expect(ask(term, answers, "\x1b[5n\x1b[?26n\x1b[?15n")).toBe("\x1b[0n\x1b[?27;1;0;1n\x1b[?13n");
		expect(ask(term, answers, "\x1b[3;5H\x1b[?6n")).toBe("\x1b[?3;5;1R");
		expect(ask(term, answers, "\x1b[?7$p\x1b[4$p\x1b[1$p\x1b[?999$p")).toBe(
			"\x1b[?7;1$y\x1b[4;2$y\x1b[1;4$y\x1b[?999;0$y",
		);
		expect(ask(term, answers, '\x1b["v')).toBe('\x1b[24;80;1;1;1"w');
		expect(ask(term, answers, "\x1b[&u")).toBe("\x1bP0!u%5\x1b\\");
	});

	it("reports settings with DECRQSS", () => {
		const { term, answers } = terminal();
		term.feed("\x1b[1;5m\x1b[3;20r");
		expect(ask(term, answers, "\x1bP$qm\x1b\\")).toBe("\x1bP0$r0;1;5m\x1b\\");
		expect(ask(term, answers, "\x1bP$qr\x1b\\")).toBe("\x1bP0$r3;20r\x1b\\");
		expect(ask(term, answers, '\x1bP$q"p\x1b\\')).toBe('\x1bP0$r64;1"p\x1b\\');
		expect(ask(term, answers, "\x1bP$qz\x1b\\")).toBe("\x1bP1$r\x1b\\");
	});

	it("restores the cursor information and tab stops it reported", () => {
		const { term, answers } = terminal();
		term.feed("\x1b[2 P\x1b[5;7H\x1b[1;4m\x1b)0\x1b*>\x1b~\x1b[?6h\x1b[5;7H");
		const cir = ask(term, answers, "\x1b[1$w");
		expect(cir).toBe("\x1bP1$u5;7;2;C;@;A;0;1;@;B0>%5\x1b\\");
		term.feed("\x1b[1 P\x1b[m\x1b(B\x1b)B\x1b}\x1b[?6l\x1b[H");
		term.feed(cir.replace("$u", "$t"));
		expect([term.page, term.row, term.col, term.sgr, term.gr, term.originMode]).toEqual([1, 4, 6, 3, 1, true]);
		expect(term.designations).toEqual(["ascii", "graphics", "technical", "dec-supplemental"]);
		const tabs = ask(term, answers, "\x1b[3g\x1b[1;5H\x1bH\x1b[1;30H\x1bH\x1b[2$w");
		expect(tabs).toBe("\x1bP2$u5/30\x1b\\");
		term.feed("\x1b[3g");
		term.feed(tabs.replace("$u", "$t"));
		term.feed("\x1b[1;1H\t");
		expect(term.col).toBe(4);
	});

	it("restores the terminal state it reported", () => {
		const { term, answers } = terminal();
		term.feed("\x1b[?7l\x1b[4h\x1b[3;9r\x1b[2$~");
		const report = ask(term, answers, "\x1b[1$u");
		expect(report).toMatch(/^\x1bP1\$s[0-9A-F]+\x1b\\$/);
		term.feed("\x1b[!p\x1b[0$~");
		expect([term.autowrap, term.statusType]).toEqual([true, 0]);
		term.feed(report.replace("1$s", "1$p"));
		expect([term.autowrap, term.insertMode, term.top, term.bottom, term.statusType]).toEqual([false, true, 2, 8, 2]);
	});

	it("checksums a rectangle", () => {
		const { term, answers } = terminal();
		term.feed("AB");
		// 0x41 + 0x42 + 78 spaces, negated
		const sum = (-(0x41 + 0x42 + 78 * 0x20) & 0xffff).toString(16).toUpperCase().padStart(4, "0");
		expect(ask(term, answers, "\x1b[7;1;1;1;1;80*y")).toBe(`\x1bP7!~${sum}\x1b\\`);
	});

	it("answers in 8-bit controls after S8C1T", () => {
		const { term, answers } = terminal();
		expect(ask(term, answers, "\x1b G\x1b[5n")).toBe("\x9b0n");
		expect(ask(term, answers, "\x1b F\x1b[5n")).toBe("\x1b[0n");
	});
});

describe("keys, macros and modes", () => {
	it("sends what the modes say for cursor, keypad, editing and function keys", () => {
		const { term } = terminal();
		expect(keyBytes(term, { key: "Up" })).toBe("\x1b[A");
		expect(keyBytes(term, { key: "KP5" })).toBe("5");
		expect(keyBytes(term, { key: "Backspace" })).toBe("\x7f");
		expect(keyBytes(term, { key: "Return" })).toBe("\r");
		term.feed("\x1b[?1h\x1b=\x1b[?67h\x1b[20h");
		expect(keyBytes(term, { key: "Up" })).toBe("\x1bOA");
		expect(keyBytes(term, { key: "KP5" })).toBe("\x1bOu");
		expect(keyBytes(term, { key: "KPEnter" })).toBe("\x1bOM");
		expect(keyBytes(term, { key: "Backspace" })).toBe("\b");
		expect(keyBytes(term, { key: "Return" })).toBe("\r\n");
		expect(keyBytes(term, { key: "Find" })).toBe("\x1b[1~");
		expect(keyBytes(term, { key: "Help" })).toBe("\x1b[28~");
		expect(keyBytes(term, { key: "F20", shift: true })).toBe("\x1b[34;2~");
		expect(keyBytes(term, { key: "PF1" })).toBe("\x1bOP");
	});

	it("types user-defined keys, and refuses new ones once locked", () => {
		const { term, answers } = terminal();
		term.feed("\x1bP1;1|34/5052494E54;17/41\x1b\\");
		expect(keyBytes(term, { key: "F20", shift: true })).toBe("PRINT");
		expect(keyBytes(term, { key: "F6", shift: true })).toBe("A");
		expect(keyBytes(term, { key: "F6" })).toBe("\x1b[17~");
		expect(ask(term, answers, "\x1b[?25n")).toBe("\x1b[?20n");
		term.feed("\x1bP1;0|18/42\x1b\\");
		expect(ask(term, answers, "\x1b[?25n")).toBe("\x1b[?21n");
		term.feed("\x1bP1;1|19/43\x1b\\");
		expect(keyBytes(term, { key: "F8", shift: true })).toBe("\x1b[19;2~");
	});

	it("types control characters, the supplemental set and pasted text", () => {
		const { term } = terminal();
		expect(keyBytes(term, { key: "c", ctrl: true })).toBe("\x03");
		expect(keyBytes(term, { key: "2", ctrl: true })).toBe("\x00");
		expect(keyBytes(term, { key: "é" })).toBe("\xe9");
		expect(keyBytes(term, { key: "x", alt: true }, { altMeta: true })).toBe("\x1bx");
		expect(keyBytes(term, { key: "ř" })).toBeUndefined();
		expect(pastedBytes(term, "a\nb\r\nć")).toBe("a\rb\r");
		term.feed("\x1b[2h");
		expect(keyBytes(term, { key: "a" })).toBeUndefined();
	});

	it("runs a macro as if it had come from the host", () => {
		const { term } = terminal();
		term.feed("\x1bP3;0;1!z!3;41;0D0A\x1b\\");
		term.feed("\x1b[3*z");
		expect(term.screen().slice(0, 2)).toEqual(["AAA", ""]);
		expect(term.row).toBe(1);
	});

	it("speaks VT52 until ESC <", () => {
		const { term, answers } = terminal();
		term.feed("\x1b[?2l\x1bY%(x\x1bFa\x1bG");
		expect(term.text(5)).toBe("        x▒");
		expect(ask(term, answers, "\x1bZ")).toBe("\x1b/Z");
		expect(keyBytes(term, { key: "Up" })).toBe("\x1bA");
		term.feed("\x1b<\x1b[1;1Hy");
		expect(term.text(0)).toBe("y");
	});

	it("sends nothing to the screen in printer controller mode, until CSI 4 i", () => {
		const { term } = terminal();
		term.feed("\x1b[5ihidden\x1b[4ishown");
		expect(term.text(0)).toBe("shown");
	});

	it("saves and restores the cursor with its rendition and character sets", () => {
		const { term } = terminal();
		term.feed("\x1b[5;5H\x1b[1m\x1b(0\x1b7\x1b[m\x1b(B\x1b[H\x1b8q");
		expect(term.text(4)).toBe("    ─");
		expect(term.attrsAt(4, 4)).toBe(ATTR_BOLD);
	});

	it("erases page memory on DECCOLM and keeps it on DECSCPP", () => {
		const { term } = terminal();
		term.feed("kept\x1b[132$|");
		expect([term.columns, term.text(0)]).toEqual([132, "kept"]);
		term.feed("\x1b[?3l");
		expect([term.columns, term.text(0)]).toEqual([80, ""]);
	});
});

describe("smooth scroll", () => {
	it("stops writing after a line that glides, until the display has shown it", () => {
		const { term } = terminal();
		const bytes = Buffer.from(`\x1b[?4h\x1b[24H\nnext\nafter`, "latin1");
		const stop = term.write(bytes, 0, bytes.length, true);
		expect(bytes.subarray(stop).toString("latin1")).toBe("next\nafter");
		expect(term.smoothScrollEvent?.direction).toBe(1);
		term.smoothScrollEvent = undefined;
		const rest = term.write(bytes, stop, bytes.length, true);
		expect(bytes.subarray(rest).toString("latin1")).toBe("after");
	});

	it("jumps when the margins leave columns out, or the scroll is several lines", () => {
		const { term } = terminal();
		const bytes = Buffer.from(`\x1b[?4h\x1b[?69h\x1b[2;40s\x1b[24;2H\nx`, "latin1");
		expect(term.write(bytes, 0, bytes.length, true)).toBe(bytes.length);
		expect(term.smoothScrollEvent).toBeUndefined();
	});
});
