import { describe, expect, it } from "vitest";
import { vt420Violations } from "./safety.ts";

const bytes = (text: string): Buffer => Buffer.from(text, "latin1");

describe("VT420 safety check", () => {
	it("accepts what the frontend sends", () => {
		const sent = [
			"\x1b F\x1b[4l\x1b[20l\x1b[12h\x1b[?7l\x1b[?6l\x1b=",
			"\x1b(B\x1b)0\x1b*>\x1b+%5\x0f\x1b[2$~\x1b[1$}\x1b[0$}",
			"\x1b[?69h\x1b[21;40s\x1b[1;12r\x1b[12;21H\x1bD\x1b[s\x1b[r\x1bM",
			"\x1b[0;1;4;5;7m\x1b[22;24;25;27m\x1b[m\x1b#6\x1b#5\x1bNa\x1bOb\x0eq\x0f\x1bo|",
			"\x1b[5X\x1b[3P\x1b[K\x1b[2J\x1b[32;1;1;1;80$x\x1b[2*x\x1b[1;1;9;3;7$t\x1b[?5h\x1b[?25l\x1b[?25h\x1b[c\x07",
			"\x1b7\x1b[2H\xc3\xa9\x1b[6n\x1b8",
		].join("");
		expect(vt420Violations(bytes(sent))).toEqual([]);
	});

	it("flags what a VT420 would misread or choke on", () => {
		const cases: Array<[string, RegExp]> = [
			["\x1b[38;5;154m", /SGR 38/],
			["\x1b[48;2;0;5;7m", /SGR 48/],
			["\x1b]0;title\x07", /control string/],
			["\x1b_Gq=1\x1b\\", /control string/],
			["\x1bP+q544e\x1b\\", /DCS/],
			["\x1b[?1049h", /private mode \?1049/],
			["\x1b[?2026h", /private mode \?2026/],
			["\x1b[>1u", /CSI/],
			["\x1b[2 q", /CSI/],
			["caf\xc3\xa9", /8-bit/],
			["\x9b2J", /8-bit/],
			["\x1bc", /ESC/],
			["\x1b", /ESC at the end/],
		];
		for (const [text, pattern] of cases)
			expect(vt420Violations(bytes(text)).join(" "), JSON.stringify(text)).toMatch(pattern);
	});

	it("lets UTF-8 through to an emulator, and GR bytes in 8-bit mode", () => {
		expect(vt420Violations(Buffer.from("café ≥ π", "utf8"), { unicode: true })).toEqual([]);
		expect(vt420Violations(bytes("\xfc\xe9"), { eightBit: true })).toEqual([]);
	});
});
