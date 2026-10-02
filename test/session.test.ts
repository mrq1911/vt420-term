import { afterEach, describe, expect, it } from "vitest";
import { Session, type SessionOptions } from "../src/session.ts";
import { EmulatedTerminal, FakeChild, settle } from "./fixtures.ts";
import { vt420Violations } from "./safety.ts";

const sessions: Session[] = [];

function start(caps: ConstructorParameters<typeof EmulatedTerminal>[0] = {}, options: SessionOptions = {}) {
	const terminal = new EmulatedTerminal(caps);
	const child = new FakeChild();
	const session = new Session(terminal, child, options);
	sessions.push(session);
	return { terminal, child, session };
}

afterEach(() => {
	for (const session of sessions.splice(0)) session.close();
});

describe("vt420-term session", () => {
	it("draws what the program prints with nothing the VT420 cannot take", async () => {
		const { terminal, child, session } = start();
		child.print(
			"\x1b]0;my title\x07\x1b[1;38;5;154mgreen\x1b[0m \x1b[38;2;0;5;7mpoison\x1b[0m ü 漢 \u{1f680}\r\n\x1bP+q544e\x1b\\\x1b_Gq=1\x1b\\after",
		);
		await settle(80);
		expect(terminal.row(0)).toBe("green poison ü ?  ?");
		expect(terminal.row(1)).toBe("after");
		expect(terminal.emulator.statusText()).toMatch(/ my title$/);
		expect(vt420Violations(terminal.bytes)).toEqual([]);
		child.exit(3);
		expect(await session.run()).toBe(3);
	});

	it("answers the program's queries itself and keeps the VT420's answers from it", async () => {
		const { terminal, child } = start();
		child.print("\x1b[c\x1b[6n");
		await settle(80);
		expect(child.input).toContain("\x1b[?1;2c");
		expect(child.input).toContain("\x1b[1;1R");
		// the VT420 answered the adapter's own requests, as a VT420 does
		expect(terminal.bytes.toString("latin1")).toContain("\x1b[c");
		expect(child.input).not.toContain("?64;");
	});

	it("passes keys on and shows Alt on the status line while the meta key waits", async () => {
		const { terminal, child } = start();
		await settle(40);
		terminal.type("\x1b[26~");
		await settle(40);
		expect(terminal.emulator.statusText()).toMatch(/^ Alt/);
		terminal.type("n\x1b[23~");
		await settle(40);
		expect(child.input).toBe("\x1bn\x1b");
		expect(terminal.emulator.statusText()).not.toMatch(/Alt/);
	});

	it("keeps the terminal at most a frame behind while it is still drawing", async () => {
		const { terminal, child } = start();
		await settle(40);
		terminal.holdAnswers = true;
		const frames = (): number => terminal.bytes.toString("latin1").split("\x1b[c").length - 1;
		const before = frames();
		for (let line = 0; line < 30; line++) {
			child.print(`line ${line}\r\n`);
			await settle(25);
		}
		expect(frames() - before).toBeLessThanOrEqual(2);
		terminal.release();
		await settle(120);
		expect(terminal.row(22)).toBe("line 29");
	});

	it("paces with DSR where the terminal answers it, and gets past answers lost on the way", async () => {
		const { terminal, child } = start({ deviceStatus: true, bytesPerSecond: 1_000_000 });
		await settle(40);
		const requests = (): number => terminal.bytes.toString("latin1").split("\x1b[5n").length - 1;
		expect(requests()).toBe(1);
		expect(terminal.bytes.toString("latin1")).not.toContain("\x1b[c");
		// answers that never come: two frames go out, the rest wait until the frames out would have been drawn
		terminal.holdAnswers = true;
		for (let line = 0; line < 10; line++) {
			child.print(`line ${line}\r\n`);
			await settle(25);
		}
		expect(requests()).toBe(3);
		expect(terminal.row(9)).not.toBe("line 9");
		await settle(1200);
		expect(terminal.row(9)).toBe("line 9");
	});

	it("shows each key and what the program got for it, with showKeys", async () => {
		const { terminal, child } = start({}, { showKeys: true });
		child.print("\x1b]0;pi\x07");
		await settle(40);
		terminal.type("\x1b[28~");
		await settle(40);
		expect(terminal.emulator.statusText()).toMatch(/^ ESC\[28~ > ESC\[1;2R +pi$/);
		terminal.type("\x1b[26~");
		await settle(40);
		expect(terminal.emulator.statusText()).toMatch(/^ Alt +pi$/);
		terminal.type("\x1bOP");
		await settle(40);
		expect(terminal.emulator.statusText()).toMatch(/^ ESCOP > ESC\[1;3P +pi$/);
	});

	it("waits for a synchronized update to finish", async () => {
		const { terminal, child } = start();
		await settle(40);
		child.print("\x1b[?2026hhalf of a frame");
		await settle(60);
		expect(terminal.row(0)).toBe("");
		child.print(", and the rest\x1b[?2026l");
		await settle(60);
		expect(terminal.row(0)).toBe("half of a frame, and the rest");
	});

	it("tells the program when the terminal changes size", async () => {
		const { terminal, child } = start();
		terminal.resize(24, 132);
		await settle(20);
		expect(child.sizes).toEqual([[132, 24]]);
	});
});
