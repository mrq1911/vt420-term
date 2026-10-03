import { describe, expect, it } from "vitest";
import { InputParser } from "../src/vt420/input.ts";
import { emptyProbe, type ProbeResult, probeQueries, recordResponse, restoreSequence } from "../src/vt420/terminal.ts";
import { type EmulatorOptions, Vt420Emulator } from "./emulator.ts";

function probe(options: EmulatorOptions): ProbeResult {
	const result = emptyProbe();
	const parser = new InputParser({
		onEvent: (event) => {
			if (event.type === "response") recordResponse(result, event.response);
		},
	});
	const emulator = new Vt420Emulator({ ...options, onResponse: (bytes) => parser.feed(bytes) });
	emulator.feed(probeQueries());
	parser.dispose();
	return result;
}

describe("vt420-term terminal probe", () => {
	it("lifts limited transmit for the session and puts it back", () => {
		const limited = probe({ rows: 24, columns: 80, transmitLimited: true });
		expect(limited.modes.get("?73")).toBe(1);
		expect(restoreSequence(limited, { statusLine: false }, {})).toContain("\x1b[?73h");
		const unlimited = probe({ rows: 24, columns: 80, transmitLimited: false });
		expect(restoreSequence(unlimited, { statusLine: false }, {})).toContain("\x1b[?73l");
		// a terminal that does not know the mode is left alone
		expect(restoreSequence(probe({ rows: 24, columns: 80 }), { statusLine: false }, {})).not.toContain("?73");
	});
});
