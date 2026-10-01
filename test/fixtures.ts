import type { SessionChild, SessionTerminal } from "../src/session.ts";
import type { TerminalCapabilities } from "../src/vt420/terminal.ts";
import { type EmulatorOptions, Vt420Emulator } from "./emulator.ts";

export const VT420: TerminalCapabilities = {
	rows: 24,
	columns: 80,
	level: 4,
	name: "VT420",
	technical: true,
	statusLine: true,
	rectangularOps: true,
	eraseCharacters: true,
	supplemental: "dec",
	eightBit: false,
	unicode: false,
	leftRightMargins: true,
};

/** The session's terminal side played by the emulator, which answers DA1 the way a VT420 does. */
export class EmulatedTerminal implements SessionTerminal {
	readonly caps: TerminalCapabilities;
	readonly emulator: Vt420Emulator;
	readonly sent: Buffer[] = [];
	backlogMs = 0;
	/** Hold the terminal's answers, as a slow line would, until `release()`. */
	holdAnswers = false;
	private listener: ((chunk: Buffer) => void) | undefined;
	private resizeHandler: (() => void) | undefined;
	private held: Buffer[] = [];

	constructor(caps: Partial<TerminalCapabilities> = {}, options: EmulatorOptions = {}) {
		this.caps = { ...VT420, ...caps };
		this.emulator = new Vt420Emulator({
			rows: this.caps.rows,
			columns: this.caps.columns,
			statusType: this.caps.statusLine ? 2 : 1,
			utf8: this.caps.unicode,
			...options,
			onResponse: (bytes) => {
				const chunk = Buffer.from(bytes, "latin1");
				if (this.holdAnswers) this.held.push(chunk);
				else this.listener?.(chunk);
			},
		});
	}

	write(bytes: string): void {
		const chunk = Buffer.from(bytes, this.caps.unicode ? "utf8" : "latin1");
		this.sent.push(chunk);
		this.emulator.feed(chunk);
	}

	onData(listener: (chunk: Buffer) => void): void {
		this.listener = listener;
	}

	onResize(handler: () => void): void {
		this.resizeHandler = handler;
	}

	/** Keys typed on the terminal. */
	type(bytes: string): void {
		this.listener?.(Buffer.from(bytes, "latin1"));
	}

	release(): void {
		this.holdAnswers = false;
		for (const chunk of this.held.splice(0)) this.listener?.(chunk);
	}

	resize(rows: number, columns: number): void {
		this.caps.rows = rows;
		this.caps.columns = columns;
		this.resizeHandler?.();
	}

	get bytes(): Buffer {
		return Buffer.concat(this.sent);
	}

	/** The screen with reverse cells as █, bold as ^ below, for readable assertions. */
	row(row: number): string {
		return this.emulator.text(row);
	}
}

/** A program that writes what the test tells it to and records what it is sent. */
export class FakeChild implements SessionChild {
	readonly received: string[] = [];
	readonly sizes: Array<[number, number]> = [];
	private dataListener: ((data: string) => void) | undefined;
	private exitListener: ((event: { exitCode: number }) => void) | undefined;

	onData(listener: (data: string) => void): void {
		this.dataListener = listener;
	}

	onExit(listener: (event: { exitCode: number }) => void): void {
		this.exitListener = listener;
	}

	write(data: string): void {
		this.received.push(data);
	}

	resize(columns: number, rows: number): void {
		this.sizes.push([columns, rows]);
	}

	print(data: string): void {
		this.dataListener?.(data);
	}

	exit(exitCode = 0): void {
		this.exitListener?.({ exitCode });
	}

	get input(): string {
		return this.received.join("");
	}
}

export const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
