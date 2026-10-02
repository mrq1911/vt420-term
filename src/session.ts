/**
 * The adapter: a program runs in a pseudo-terminal and believes it talks to xterm, xterm.js emulates that terminal
 * in memory, and the VT420 only ever sees what the renderer draws from the emulated screen. Frames are composed from
 * the latest state, so a program that floods its output costs the serial line no more than the screen it ends up
 * showing; they wait for synchronized updates to finish, and each ends with a DSR request (DA1 where the terminal
 * ignores DSR) so the terminal is never more than a frame behind, whatever it is still drawing.
 */

import { Unicode11Addon } from "@xterm/addon-unicode11";
import xterm from "@xterm/headless";
import { KeyTranslator } from "./keys.ts";
import { ScreenMapper } from "./screen.ts";
import { ATTR_BOLD, BLANK } from "./vt420/cells.ts";
import { Charset } from "./vt420/charset.ts";
import { type Frame, type Renderer, rendererFor } from "./vt420/renderer.ts";
import { DEC_ESCAPE_TIMEOUT_MS, EMULATOR_ESCAPE_TIMEOUT_MS, type TerminalCapabilities } from "./vt420/terminal.ts";
import { spaces, truncateCells } from "./vt420/text.ts";

/** The terminal side: a VT420, or anything that plays one. */
export interface SessionTerminal {
	readonly caps: TerminalCapabilities;
	/** Milliseconds until what was written has gone out at the known line speed. */
	readonly backlogMs: number;
	write(bytes: string): void;
	onData(listener: (chunk: Buffer) => void): void;
	onResize(handler: () => void): void;
}

/** The program side, as node-pty provides it. */
export interface SessionChild {
	onData(listener: (data: string) => void): unknown;
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
	write(data: string): void;
	resize(columns: number, rows: number): void;
}

export interface SessionOptions {
	/** Function key that puts ESC before the next key; "none" turns it off. */
	metaKey?: string;
	/** Shortest time between frames. */
	frameMs?: number;
	/** Show the last key the terminal sent, and what the program got for it, on the status line. */
	showKeys?: boolean;
}

/** Bytes as a status line can show them: ESC, ^X for other controls. */
function visible(bytes: string): string {
	let out = "";
	for (const char of bytes) {
		const code = char.charCodeAt(0);
		if (code === 0x1b) out += "ESC";
		else if (code < 0x20) out += `^${String.fromCharCode(code + 0x40)}`;
		else if (code === 0x7f) out += "^?";
		else out += char;
	}
	return out.length > 24 ? `${out.slice(0, 23)}…` : out;
}

/** Frames sent but not yet answered, at most. */
const SYNC_WINDOW = 2;
/** Line speed assumed for how long an answer may take when the real one is unknown: 9600 baud. */
const SYNC_BYTES_PER_SECOND = 960;
/** How long a synchronized update may hold back frames before the screen is drawn anyway. */
const SYNCHRONIZED_HOLD_MS = 150;

export class Session {
	private readonly io: SessionTerminal;
	private readonly child: SessionChild;
	private readonly term: InstanceType<typeof xterm.Terminal>;
	private readonly charset: Charset;
	private readonly screen: ScreenMapper;
	private readonly keys: KeyTranslator;
	private readonly frameMs: number;
	private renderer: Renderer;
	private dirty = true;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private answerTimer: ReturnType<typeof setTimeout> | undefined;
	/** Bytes of each frame the terminal has not answered yet. */
	private unanswered: number[] = [];
	/** Ends each frame: DSR 5, whose answer is four bytes, or DA1 where DSR goes unanswered. */
	private sync: string | undefined;
	private lastFrame = 0;
	private heldSince: number | undefined;
	private cursorVisible = true;
	private title = "";
	private bell = false;
	private closed = false;
	private readonly showKeys: boolean;
	private keyIn = "";
	private keyOut = "";
	private exited: Promise<number>;

	constructor(io: SessionTerminal, child: SessionChild, options: SessionOptions = {}) {
		this.io = io;
		this.child = child;
		this.frameMs = options.frameMs ?? 16;
		this.showKeys = options.showKeys ?? false;
		const caps = io.caps;
		this.sync = caps.deviceStatus ? "\x1b[5n" : caps.level > 0 ? "\x1b[c" : undefined;
		this.charset = new Charset({
			technical: caps.technical,
			supplemental: caps.supplemental,
			eightBit: caps.eightBit,
		});
		this.screen = new ScreenMapper(this.charset);
		this.renderer = rendererFor(caps);
		this.term = new xterm.Terminal({ cols: caps.columns, rows: caps.rows, allowProposedApi: true, scrollback: 0 });
		// programs count emoji and East Asian wide characters as two columns, as Unicode 9 and later do
		this.term.loadAddon(new Unicode11Addon());
		this.term.unicode.activeVersion = "11";
		const cursorMode = (visible: boolean) => (params: (number | number[])[]) => {
			if (params.includes(25)) this.cursorVisible = visible;
			return false;
		};
		this.term.parser.registerCsiHandler({ prefix: "?", final: "h" }, cursorMode(true));
		this.term.parser.registerCsiHandler({ prefix: "?", final: "l" }, cursorMode(false));
		this.term.onData((data) => child.write(data));
		this.term.onTitleChange((title) => {
			this.title = title;
			this.changed();
		});
		this.term.onBell(() => {
			this.bell = true;
			this.changed();
		});
		this.keys = new KeyTranslator({
			send: (bytes) => {
				child.write(bytes);
				if (this.showKeys) {
					this.keyOut = visible(bytes);
					this.changed();
				}
			},
			answered: () => this.answered(false),
			modes: () => ({
				applicationCursorKeys: this.term.modes.applicationCursorKeysMode,
				applicationKeypad: this.term.modes.applicationKeypadMode,
			}),
			supplemental: () => this.io.caps.supplemental,
			unicode: () => this.io.caps.unicode,
			metaKey: options.metaKey === "none" ? undefined : (options.metaKey ?? "f14"),
			metaChanged: () => this.changed(),
			escapeTimeoutMs: Math.max(
				caps.unicode ? EMULATOR_ESCAPE_TIMEOUT_MS : DEC_ESCAPE_TIMEOUT_MS,
				caps.bytesPerSecond ? 4000 / caps.bytesPerSecond : 0,
			),
		});
		this.exited = new Promise((resolve) => {
			child.onExit(({ exitCode }) => {
				this.close();
				resolve(exitCode);
			});
		});
		child.onData((data) => this.term.write(data, () => this.changed()));
		io.onData((chunk) => {
			// the terminal's answers to the adapter's own requests are not keys
			if (this.showKeys && !/^\x1b\[(\?[\d;]*c|[03]n)$/.test(chunk.toString("latin1"))) {
				this.keyIn = visible(chunk.toString("latin1"));
				this.keyOut = "";
				this.changed();
			}
			this.keys.feed(chunk);
		});
		io.onResize(() => this.resize());
		this.schedule(0);
	}

	/** Resolves with the program's exit code. */
	run(): Promise<number> {
		return this.exited;
	}

	/** The emulated terminal, for tests. */
	get emulated(): InstanceType<typeof xterm.Terminal> {
		return this.term;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.timer);
		clearTimeout(this.answerTimer);
		this.keys.dispose();
		this.term.dispose();
	}

	private changed(): void {
		this.dirty = true;
		this.schedule();
	}

	private schedule(delay?: number): void {
		if (this.closed || this.timer) return;
		const wait = delay ?? Math.max(0, this.frameMs - (Date.now() - this.lastFrame), this.io.backlogMs - 20);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.frame();
		}, wait);
	}

	private frame(): void {
		if (this.closed || !this.dirty) return;
		if (this.term.modes.synchronizedOutputMode) {
			this.heldSince ??= Date.now();
			if (Date.now() - this.heldSince < SYNCHRONIZED_HOLD_MS) {
				this.schedule(10);
				return;
			}
		}
		this.heldSince = undefined;
		// the answer to an earlier frame schedules this one
		if (this.unanswered.length >= SYNC_WINDOW) return;
		const caps = this.io.caps;
		const frame: Frame = {
			lines: this.screen.lines(this.term),
			status: caps.statusLine ? this.statusCells() : undefined,
			cursor: this.screen.cursor(this.term, this.cursorVisible),
			scroll: { top: 0, bottom: caps.rows - 1 },
		};
		this.dirty = false;
		let bytes = this.renderer.render(frame);
		if (this.bell) {
			bytes += "\x07";
			this.bell = false;
		}
		if (bytes === "") return;
		if (this.sync) {
			bytes += this.sync;
			this.unanswered.push(bytes.length);
			this.armAnswerTimer();
		}
		this.io.write(bytes);
		this.lastFrame = Date.now();
	}

	private answered(timedOut: boolean): void {
		if (this.unanswered.length === 0) return;
		// past the time the frames out could take, an answer counts as lost on the way
		if (timedOut) this.unanswered = [];
		else this.unanswered.shift();
		this.armAnswerTimer();
		if (this.dirty) this.schedule();
	}

	private armAnswerTimer(): void {
		clearTimeout(this.answerTimer);
		this.answerTimer = undefined;
		if (this.unanswered.length === 0) return;
		const bytes = this.unanswered.reduce((sum, length) => sum + length, 0);
		const ms = 1000 + (bytes * 1000) / (this.io.caps.bytesPerSecond ?? SYNC_BYTES_PER_SECOND);
		this.answerTimer = setTimeout(() => this.answered(true), ms);
	}

	/** The program's title on the right, as the footer sits in pi-vt420, and Alt while the meta key is pending. */
	private statusCells(): number[] {
		const columns = this.io.caps.columns;
		const keys = this.showKeys && this.keyIn ? ` ${this.keyIn} > ${this.keyOut || "nothing"}` : "";
		const left = this.keys.metaPending ? this.charset.cells(" Alt", ATTR_BOLD) : keys ? this.charset.cells(keys) : [];
		const room = Math.max(0, columns - 2 - left.length - 1);
		const title = truncateCells(this.charset.cells(this.title), room, this.charset.cells("…"));
		return [...left, ...spaces(columns - 1 - left.length - title.length), ...title, BLANK];
	}

	private resize(): void {
		const { rows, columns } = this.io.caps;
		this.term.resize(columns, rows);
		this.child.resize(columns, rows);
		this.renderer = rendererFor(this.io.caps);
		this.changed();
	}
}
