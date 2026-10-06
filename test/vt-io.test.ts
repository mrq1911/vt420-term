import { describe, expect, it } from "vitest";
import { Vt420 } from "../src/emu/vt420.ts";
import { atoms, pieces } from "../src/vt-io.ts";

describe("pacing pieces", () => {
	it("keeps sequences whole, stray ESCs and controls inside sequences as the terminal takes them", () => {
		expect(atoms("a\x1b\x1b[18;56H\x1b\n\x1b[?5hx\x1bOq\x1b(0q")).toEqual([
			"a",
			"\x1b",
			"\x1b[18;56H",
			"\x1b\n",
			"\x1b[?5h",
			"x",
			"\x1bOq",
			"\x1b(0",
			"q",
		]);
	});

	it("draws the same screen with a request after every piece as without", () => {
		// what old animations have in them: stray ESCs, controls inside sequences, shifts, strings, cancelled ones
		let text = "";
		for (let i = 0; i < 60; i++) {
			text += `\x1b[${(i % 20) + 1};${(i * 7) % 70}H\x1b\x1b[${(i % 3) + 1}mframe ${i}\x1b\n`;
			text += `\x1b[2\x18J\x1b(0lqk\x1b(B\x1bN\x7f\x1b*0\x1bNa\x1b[1\r;5H\x1bPignored\x1b\\\x1b]0;title\x07x\x1b\\`;
			text += "\x1b#6wide\x1b#5\x1b[?7l";
		}
		const plain = new Vt420();
		plain.feed(text);
		const paced = new Vt420();
		for (const piece of pieces(text, 48)) paced.feed(`${piece}\x1b[5n`);
		expect(paced.pages).toEqual(plain.pages);
	});
});
