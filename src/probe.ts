/**
 * vt420-probe: asks the terminal it runs on what vt420 has to know to behave as it does, and writes the answers
 * and timings to a JSON file that vt420-term's conformance test checks vt420 against. Run it on a VT420, from a
 * session on the terminal itself (a login on its serial port times it best), with nothing else on the screen to
 * keep: it draws over it and clears it.
 *
 * It never sends more than a couple of hundred characters without waiting for an answer, so the terminal's input
 * buffer holds them with flow control or without, and it puts back the modes it changes. It leaves out DA3, the
 * unit's serial number, and the answerback message.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { ANSI_MODES, CASES, MODES, REPORTS, SETTINGS, START } from "./probe-cases.ts";

const VERSION = 1;
const ANSWER_MS = 2000;

interface Received {
	at: number;
	byte: number;
}

const incoming: Received[] = [];
let waiting: (() => void) | undefined;

function write(bytes: string): void {
	process.stdout.write(Buffer.from(bytes, "latin1"));
}

/** The next control sequence or string the terminal sends, with when its first and last bytes came. */
async function answer(timeoutMs = ANSWER_MS): Promise<{ text: string; first: number; last: number } | undefined> {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const found = takeSequence();
		if (found) return found;
		const left = deadline - performance.now();
		if (left <= 0) return undefined;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, left);
			waiting = () => {
				clearTimeout(timer);
				resolve();
			};
		});
	}
}

function takeSequence(): { text: string; first: number; last: number } | undefined {
	// flow control and anything before a sequence's start are not answers
	while (incoming.length > 0 && ![0x1b, 0x9b, 0x90].includes(incoming[0]!.byte)) incoming.shift();
	if (incoming.length === 0) return undefined;
	const bytes = incoming.map((entry) => entry.byte);
	let end = -1;
	const string = bytes[0] === 0x90 || (bytes[0] === 0x1b && bytes[1] === 0x50);
	for (let i = 1; i < bytes.length; i++) {
		const byte = bytes[i]!;
		if (byte === 0x11 || byte === 0x13) continue;
		if (string) {
			if (byte === 0x9c || (byte === 0x5c && bytes[i - 1] === 0x1b)) {
				end = i;
				break;
			}
		} else if (i >= (bytes[0] === 0x1b ? 2 : 1) && byte >= 0x40 && byte <= 0x7e) {
			end = i;
			break;
		}
	}
	if (end < 0) return undefined;
	const taken = incoming.splice(0, end + 1).filter((entry) => entry.byte !== 0x11 && entry.byte !== 0x13);
	return {
		text: String.fromCharCode(...taken.map((entry) => entry.byte)),
		first: taken[0]!.at,
		last: taken.at(-1)!.at,
	};
}

async function ask(query: string): Promise<string | null> {
	write(query);
	return (await answer())?.text ?? null;
}

/** Send, then wait for the answer to a DSR after it: the milliseconds all of it took. */
async function sync(bytes: string): Promise<number> {
	const start = performance.now();
	write(`${bytes}\x1b[5n`);
	for (;;) {
		const found = await answer(10_000);
		if (!found) return Number.NaN;
		if (found.text === "\x1b[0n" || found.text === "\x9b0n") return found.last - start;
	}
}

function median(values: number[]): number {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function lineSpeed(): number | undefined {
	try {
		return Number(
			execFileSync("stty", ["speed"], { stdio: ["inherit", "pipe", "ignore"] })
				.toString()
				.trim(),
		);
	} catch {
		return undefined;
	}
}

async function main(): Promise<void> {
	const path = process.argv[2] ?? "vt420-probe.json";
	if (!process.stdin.isTTY) {
		process.stderr.write("vt420-probe: run it on the terminal, with its tty on standard input\n");
		process.exit(2);
	}
	const baud = lineSpeed();
	let aborted = false;
	process.stdin.setRawMode(true);
	process.stdin.on("data", (chunk: Buffer) => {
		const at = performance.now();
		for (const byte of chunk) {
			// Ctrl+C on the keyboard stops it, with the terminal put back
			if (byte === 0x03) aborted = true;
			incoming.push({ at, byte });
		}
		waiting?.();
	});
	const result: Record<string, unknown> = { version: VERSION, date: new Date().toISOString().slice(0, 10), baud };

	const modes: Record<string, string | null> = {};
	for (const number of MODES) modes[`?${number}`] = await ask(`\x1b[?${number}$p`);
	for (const number of ANSI_MODES) modes[String(number)] = await ask(`\x1b[${number}$p`);
	result.modes = modes;
	const settings: Record<string, string | null> = {};
	for (const setting of SETTINGS) settings[setting] = await ask(`\x1bP$q${setting}\x1b\\`);
	result.settings = settings;
	const reports: Record<string, string | null> = {};
	for (const report of REPORTS) reports[report] = await ask(report);
	result.reports = reports;

	const cases: Array<{ name: string; answers: Array<string | null> }> = [];
	for (const probe of CASES) {
		if (aborted) break;
		await sync(START);
		write(probe.send);
		const answers: Array<string | null> = [];
		for (const question of probe.ask) answers.push(await ask(question));
		if (probe.then) write(probe.then);
		cases.push({ name: probe.name, answers });
	}
	result.cases = cases;

	if (!aborted) result.timing = await timing(modes);
	await restore(modes, settings);
	writeFileSync(path, `${JSON.stringify(result, null, "\t")}\n`);
	write(`vt420-probe: ${cases.length} cases${aborted ? " (stopped)" : ""}, written to ${path}\r\n`);
	process.exit(0);
}

/** How long the terminal takes over things, as the line model needs to know. */
async function timing(modes: Record<string, string | null>): Promise<Record<string, unknown>> {
	await sync(START);
	const rtt: number[] = [];
	for (let i = 0; i < 12; i++) rtt.push(await sync(""));
	const roundTrip = median(rtt);
	const glides: number[] = [];
	for (let i = 0; i < 3; i++) {
		await sync(`${START}\x1b[24H`);
		glides.push((await sync(`\x1b[?4h${"\n".repeat(6)}`)) - roundTrip);
		await sync("\x1b[?4l");
	}
	const narrowGlides: number[] = [];
	for (let i = 0; i < 2; i++) {
		await sync(`${START}\x1b[20;21r\x1b[21H`);
		narrowGlides.push((await sync(`\x1b[?4h${"\n".repeat(6)}`)) - roundTrip);
		await sync("\x1b[?4l");
	}
	await sync(`${START}\x1b[24H`);
	const jump = (await sync("\n".repeat(24))) - roundTrip;
	await sync(START);
	const text = (await sync(`\x1b[?7l${"x".repeat(150)}`)) - roundTrip;
	await sync(START);
	const reverseFill = (await sync("\x1b[7m\x1b[32;1;1;24;80$x\x1b[m")) - roundTrip;
	const clear = (await sync("\x1b[2J")) - roundTrip;
	// a long answer with limited transmit, if the terminal can be set to it
	let limitedCps: number | undefined;
	if (modes["?73"] && !/;0\$y$/.test(modes["?73"])) {
		write("\x1b[?73h\x1b[1$u");
		const report = await answer(15_000);
		if (report && report.text.length > 10)
			limitedCps = (report.text.length - 1) / ((report.last - report.first) / 1000);
		write(/;1\$y$/.test(modes["?73"]) ? "" : "\x1b[?73l");
		await sync("");
	}
	return {
		roundTripMs: roundTrip,
		roundTrips: rtt,
		glideMsPerLine: glides.map((ms) => ms / 6),
		narrowGlideMsPerLine: narrowGlides.map((ms) => ms / 6),
		jumpScrollMsFor24Lines: jump,
		textMsFor150: text,
		reverseFillMs: reverseFill,
		clearMs: clear,
		limitedCps,
	};
}

/** Put back what the cases change: the modes as they were, the margins, the status line and the size. */
async function restore(modes: Record<string, string | null>, settings: Record<string, string | null>): Promise<void> {
	let back = "\x1b[!p\x1b[?69l\x1b[1 P\x1b[r\x1b[m";
	for (const number of [1, 4, 5, 7, 25, 66, 67, 73]) {
		const value = /;([12])\$y$/.exec(modes[`?${number}`] ?? "")?.[1];
		if (value) back += `\x1b[?${number}${value === "1" ? "h" : "l"}`;
	}
	// a valid report has the setting in it, whichever of 0 and 1 the terminal takes for valid
	const report = (setting: string): string | undefined =>
		/^(?:\x1bP|\x90)[01]\$r(.+?)(?:\x1b\\|\x9c)$/.exec(settings[setting] ?? "")?.[1];
	for (const setting of ["$~", "$|", "*|"]) {
		const value = report(setting);
		if (value) back += `\x1b[${value}`;
	}
	await sync(`${back}\x1b[H\x1b[2J`);
}

await main();
