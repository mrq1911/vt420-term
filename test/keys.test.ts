import { describe, expect, it } from "vitest";
import { type KeyModes, KeyTranslator } from "../src/keys.ts";
import { settle } from "./fixtures.ts";

function translator(unicode = false) {
	const sent: string[] = [];
	const meta: boolean[] = [];
	let answers = 0;
	let modes: KeyModes = { applicationCursorKeys: false, applicationKeypad: false };
	const keys = new KeyTranslator({
		send: (bytes) => sent.push(bytes),
		answered: () => answers++,
		modes: () => modes,
		supplemental: () => "dec",
		unicode: () => unicode,
		metaKey: "f14",
		metaChanged: (pending) => meta.push(pending),
		escapeTimeoutMs: 10,
	});
	return {
		keys,
		sent,
		meta,
		answers: () => answers,
		setModes: (next: KeyModes) => {
			modes = next;
		},
		type: (text: string | number[]): string => {
			sent.length = 0;
			keys.feed(typeof text === "string" ? Buffer.from(text, "latin1") : Buffer.from(text));
			return sent.join("");
		},
	};
}

describe("keyboard translation", () => {
	it("passes ordinary input through and keeps BS and DEL apart", () => {
		const { type } = translator();
		expect(type("ls -l\r\x08\x7f\x10\x03")).toBe("ls -l\r\x08\x7f\x10\x03");
	});

	it("types Escape, BS and LF on F11 to F13, and Home and End on Find and Select", async () => {
		const { type, sent, setModes } = translator();
		// after Escape the next key waits, so the program cannot take the two for Alt and a key
		expect(type("\x1b[23~\x1b[24~\x1b[25~\x1b[1~\x1b[4~")).toBe("\x1b");
		await settle(100);
		expect(sent.join("")).toBe("\x1b\b\n\x1b[H\x1b[F");
		// Do is F5, which the LK401 has no code for
		expect(type("\x1b[29~")).toBe("\x1b[15~");
		setModes({ applicationCursorKeys: true, applicationKeypad: false });
		expect(type("\x1b[1~\x1b[4~")).toBe("\x1bOH\x1bOF");
	});

	it("follows the program's cursor and keypad modes", () => {
		const { type, setModes } = translator();
		expect(type("\x1b[A\x1bOB")).toBe("\x1b[A\x1b[B");
		expect(type("\x1bOq\x1bOm\x1bOM")).toBe("1-\r");
		setModes({ applicationCursorKeys: true, applicationKeypad: true });
		expect(type("\x1b[A\x1bOq\x1bOP")).toBe("\x1bOA\x1bOq\x1bOP");
	});

	it("sends Alt with the key after the meta key", () => {
		const { type, meta } = translator();
		expect(type("\x1b[26~")).toBe("");
		expect(type("n")).toBe("\x1bn");
		expect(type("\x1b[26~\x1b[D")).toBe("\x1b[1;3D");
		expect(type("\x1b[26~\x1b[17~")).toBe("\x1b[17;3~");
		// twice is F14 itself, as xterm sends it
		expect(type("\x1b[26~\x1b[26~x")).toBe("\x1b[1;2Qx");
		// PF1 to PF4 are xterm's F1 to F4, which carry Alt as a parameter
		expect(type("\x1b[26~\x1bOP")).toBe("\x1b[1;3P");
		expect(meta).toEqual([true, false, true, false, true, false, true, false, true, false]);
	});

	it("sends Help and F17 to F20 as xterm's F15 and F17 to F20, Shift with F3 and F5 to F8", () => {
		const { type } = translator();
		expect(type("\x1b[28~\x1b[31~\x1b[32~\x1b[33~\x1b[34~")).toBe(
			"\x1b[1;2R\x1b[15;2~\x1b[17;2~\x1b[18;2~\x1b[19;2~",
		);
		// with Alt as well
		expect(type("\x1b[26~\x1b[28~")).toBe("\x1b[1;4R");
		const plain = new KeyTranslator({
			send: (bytes) => sent.push(bytes),
			answered: () => {},
			modes: () => ({ applicationCursorKeys: false, applicationKeypad: false }),
			supplemental: () => "dec",
			unicode: () => false,
		});
		const sent: string[] = [];
		// without a meta key F14 goes to the program too
		plain.feed(Buffer.from("\x1b[26~"));
		expect(sent).toEqual(["\x1b[1;2Q"]);
		plain.dispose();
	});

	it("keeps the terminal's answers from the program", () => {
		const { type, answers } = translator();
		expect(type("\x1b[?64;1;2;6;7;8;9;15;18;19;21c\x1bP0$r1$~\x1b\\\x1b[?25;1$y\x1b[0n")).toBe("");
		expect(answers()).toBe(2);
	});

	it("turns 8-bit supplemental characters, or UTF-8 from an emulator, into Unicode", () => {
		expect(translator().type([0xfc, 0x41])).toBe("üA");
		expect(translator(true).type([0xc3, 0xbc, 0x41])).toBe("üA");
	});

	it("sends a lone ESC once the rest of a sequence has not come", async () => {
		const { keys, type } = translator();
		expect(type("\x1b")).toBe("");
		const sent: string[] = [];
		const late = new KeyTranslator({
			send: (bytes) => sent.push(bytes),
			answered: () => {},
			modes: () => ({ applicationCursorKeys: false, applicationKeypad: false }),
			supplemental: () => "dec",
			unicode: () => true,
			escapeTimeoutMs: 10,
		});
		late.feed(Buffer.from("\x1b"));
		await settle(30);
		expect(sent).toEqual(["\x1b"]);
		// Alt from an emulator arrives as ESC and the key together, and goes on at once
		await settle(100);
		expect(type("\x1bx")).toBe("\x1bx");
		keys.dispose();
		late.dispose();
	});
});
