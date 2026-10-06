import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FACTORY_SETUP, Vt420, type Vt420Setup } from "../src/emu/vt420.ts";
import { CASES, START } from "../src/probe-cases.ts";

/** What vt420-probe recorded on a real VT420. */
interface Recording {
	baud?: number;
	modes: Record<string, string | null>;
	settings: Record<string, string | null>;
	reports: Record<string, string | null>;
	cases: Array<{ name: string; answers: Array<string | null> }>;
	timing?: Record<string, unknown>;
}

const FIXTURE = new URL("./fixtures/vt420-probe.json", import.meta.url);
const recording: Recording | undefined = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : undefined;

/** Set-Up as the recording shows it, for what a soft reset leaves alone. */
function setupOf(recording: Recording): Partial<Vt420Setup> {
	const mode = (name: string): boolean | undefined => {
		const value = /;([12])\$y$/.exec(recording.modes[name] ?? "")?.[1];
		return value === undefined ? undefined : value === "1";
	};
	const setting = (name: string): number | undefined => {
		const value = /^(?:\x1bP|\x90)[01]\$r(\d+)/.exec(recording.settings[name] ?? "")?.[1];
		return value === undefined ? undefined : Number(value);
	};
	const defined = <T>(value: T | undefined, fallback: T): T => (value === undefined ? fallback : value);
	return {
		columns: defined(setting("$|"), 80),
		lines: defined(setting("*|"), 24),
		pageLines: defined(setting("t"), 24),
		statusDisplay: defined(setting("$~"), 1),
		smoothScroll: defined(mode("?4"), FACTORY_SETUP.smoothScroll),
		autowrap: defined(mode("?7"), FACTORY_SETUP.autowrap),
		transmitLimited: defined(mode("?73"), FACTORY_SETUP.transmitLimited),
		userPreferred: /A/.test(recording.reports["\x1b[&u"] ?? "") ? "latin1" : "dec",
		udkLocked: recording.reports["\x1b[?25n"]?.includes("?21n") ?? false,
		worldwide: /\?6\d;(\d+;)*9;/.test(recording.reports["\x1b[c"] ?? ""),
	};
}

/** A VT420 set up as the recorded one, with its tab stops and attribute extent, which a soft reset keeps. */
function terminalOf(recording: Recording, onResponse: (bytes: string) => void): Vt420 {
	const term = new Vt420({ setup: setupOf(recording), onResponse });
	const tabs = /^\x1bP2\$u(.*)\x1b\\$/.exec(recording.reports["\x1b[2$w"] ?? "")?.[1];
	if (tabs !== undefined) term.feed(`\x1bP2$t${tabs}\x1b\\`);
	const extent = /^\x1bP[01]\$r(\d)\*x/.exec(recording.settings["*x"] ?? "")?.[1];
	if (extent !== undefined) term.feed(`\x1b[${extent}*x`);
	return term;
}

/** Reports that tell what was on the screen and the line before the probe, not how the terminal works. */
const HISTORY = new Set(["\x1b[1$u", "\x1b[1$w", "\x1b[?75n"]);

describe.skipIf(!recording)("vt420 against a recorded VT420", () => {
	it("does what the VT420 did, case by case", () => {
		const answers: string[] = [];
		const term = terminalOf(recording!, (bytes) => answers.push(bytes));
		const differences: string[] = [];
		for (const recorded of recording!.cases) {
			const probe = CASES.find((candidate) => candidate.name === recorded.name);
			if (!probe) continue;
			term.feed(START);
			term.feed(probe.send);
			probe.ask.forEach((question, index) => {
				answers.length = 0;
				term.feed(question);
				const ours = answers.join("") || null;
				const theirs = recorded.answers[index] ?? null;
				if (ours !== theirs)
					differences.push(
						`${probe.name}: ${JSON.stringify(question)} ${JSON.stringify(theirs)}, vt420 ${JSON.stringify(ours)}`,
					);
			});
			if (probe.after) term.feed(probe.after);
		}
		expect(differences).toEqual([]);
	});

	it("answers the reports as the VT420 did", () => {
		const answers: string[] = [];
		const term = terminalOf(recording!, (bytes) => answers.push(bytes));
		const differences: string[] = [];
		for (const [report, theirs] of Object.entries(recording!.reports)) {
			if (HISTORY.has(report)) continue;
			answers.length = 0;
			term.feed(report);
			const ours = answers.join("") || null;
			if (ours !== theirs)
				differences.push(`${JSON.stringify(report)} ${JSON.stringify(theirs)}, vt420 ${JSON.stringify(ours)}`);
		}
		expect(differences).toEqual([]);
	});
});
