import { describe, expect, it } from "vitest";
import { type LineOptions, ManualClock, SerialLine } from "../src/emu/line.ts";
import { RECOMMENDED_SETUP, Vt420, type Vt420Setup } from "../src/emu/vt420.ts";

function connect(options: Partial<LineOptions> = {}, setup: Partial<Vt420Setup> = {}) {
	const clock = new ManualClock();
	const host: string[] = [];
	const flow: boolean[] = [];
	const line = new SerialLine({
		baud: 9600,
		glideMs: 100,
		clock,
		onHost: (bytes) => host.push(bytes),
		onFlow: (xoff) => flow.push(xoff),
		...options,
	});
	const term = new Vt420({ setup: { ...RECOMMENDED_SETUP, ...setup }, onResponse: line.answer });
	line.attach(term);
	return { clock, line, term, host, flow };
}

describe("serial line", () => {
	it("takes ten bit times a character", () => {
		const { clock, line, term } = connect({}, { autowrap: true });
		line.write("x".repeat(96));
		clock.advance(50);
		expect(term.text(0)).toBe("x".repeat(48));
		clock.advance(51);
		expect(term.text(0)).toBe("x".repeat(80));
		expect(term.text(1)).toBe("x".repeat(16));
	});

	it("answers at the line's speed, and at 165 characters a second with limited transmit", () => {
		const fast = connect({ baud: 38400 });
		fast.line.write("\x1b[5n");
		// the request's four characters, each taken in in 0.45 ms, then the answer's four
		fast.clock.advance(2);
		expect(fast.host.join("")).toBe("\x1b");
		fast.clock.advance(0.7);
		expect(fast.host.join("")).toBe("\x1b[0n");
		const slow = connect({ baud: 38400 }, { transmitLimited: true });
		slow.line.write("\x1b[5n");
		slow.clock.advance(20);
		expect(slow.host.join("")).toBe("\x1b[0");
		slow.clock.advance(10);
		expect(slow.host.join("")).toBe("\x1b[0n");
	});

	it("takes nothing in while a line glides, and loses what a host that ignores XOFF sends past a full buffer", () => {
		const { clock, line, flow } = connect({ baud: 38400 }, { smoothScroll: true });
		// ten lines that each scroll, at a tenth of a second a glide, and 400 characters behind them at once
		line.write(`\x1b[24H${"\n".repeat(10)}${"y".repeat(400)}`);
		clock.advance(150);
		expect(line.stats.glides).toBe(2);
		expect(line.buffered).toBe(254);
		clock.settle();
		// XOFF at 128 and at 220, and again for each character that found the buffer full
		expect(line.stats.lost).toBeGreaterThan(100);
		expect(line.stats.xoffs).toBe(2 + line.stats.lost);
		expect(line.stats.peak).toBe(254);
		expect(flow.at(-1)).toBe(false);
	});

	it("loses nothing when the host stops soon after XOFF, and goes on at XON", () => {
		const { clock, line, term, flow } = connect(
			{ baud: 38400, hostStopsAfter: 2 },
			{ smoothScroll: true, autowrap: true },
		);
		const text = "z".repeat(1000);
		line.write(`\x1b[24H${"\n".repeat(10)}${text}`);
		clock.settle();
		expect(line.stats.lost).toBe(0);
		// XOFF crosses in a character's time, the host sends two more, and one was on the way
		expect(line.stats.peak).toBe(128 + 4);
		expect(flow.filter((xoff) => xoff).length).toBeGreaterThan(0);
		expect(term.screen().join("").replace(/ /g, "")).toBe(text);
	});

	it("holds input with Hold Screen", () => {
		const { clock, line, term } = connect();
		line.hold(true);
		line.write("held");
		clock.advance(20);
		expect(term.text(0)).toBe("");
		expect(line.buffered).toBe(4);
		line.hold(false);
		clock.advance(2);
		expect(term.text(0)).toBe("held");
	});

	it("sends nothing but flow control after the host's XOFF, until its XON", () => {
		const { clock, line, host } = connect();
		line.write("\x13\x1b[5n");
		clock.advance(20);
		expect(host).toEqual([]);
		line.write("\x11");
		clock.advance(20);
		expect(host.join("")).toBe("\x1b[0n");
	});
});
