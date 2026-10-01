/**
 * The adapter: a program runs in a pseudo-terminal and believes it talks to xterm, xterm.js emulates that terminal
 * in memory, and the VT420 only ever sees what the renderer draws from the emulated screen. Frames are composed from
 * the latest state, so a program that floods its output costs the serial line no more than the screen it ends up
 * showing; they wait for synchronized updates to finish, and each ends with a DA1 request so the terminal is never
 * more than a frame behind, whatever it is still drawing.
 */

import { Unicode11Addon } from "@xterm/addon-unicode11";
import xterm from "@xterm/headless";
import { KeyTranslator } from "./keys.ts";
import { ScreenMapper } from "./screen.ts";
import { ATTR_BOLD, BLANK } from "./vt420/cells.ts";
import { Charset } from "./vt420/charset.ts";
import { type Frame, type Renderer, rendererFor } from "./vt420/renderer.ts";
import type { TerminalCapabilities } from "./vt420/terminal.ts";
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
}

const SYNC = "\x1b[c";
/** Frames sent but not yet answered, at most. */
const SYNC_WINDOW = 2;
const SYNC_TIMEOUT_MS = 1000;
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
	private unanswered = 0;
	private sync: boolean;
	private lastFrame = 0;
	private heldSince: number | undefined;
	private cursorVisible = true;
	private title = "";
	private bell = false;
	private closed = false;
	private exited: Promise<number>;

	constructor(io: SessionTerminal, child: SessionChild, options: SessionOptions = {}) {
		this.io = io;
		this.child = child;
		this.frameMs = options.frameMs ?? 16;
		const caps = io.caps;
		this.sync = caps.level > 0;
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
			send: (bytes) => child.write(bytes),
			answered: () => this.answered(false),
			modes: () => ({
				applicationCursorKeys: this.term.modes.applicationCursorKeysMode,
				applicationKeypad: this.term.modes.applicationKeypadMode,
			}),
			supplemental: () => this.io.caps.supplemental,
			unicode: () => this.io.caps.unicode,
			metaKey: options.metaKey === "none" ? undefined : (options.metaKey ?? "f14"),
			metaChanged: () => this.changed(),
			escapeTimeoutMs: caps.bytesPerSecond ? Math.max(50, 4000 / caps.bytesPerSecond) : 50,
		});
		this.exited = new Promise((resolve) => {
			child.onExit(({ exitCode }) => {
				this.close();
				resolve(exitCode);
			});
		});
		child.onData((data) => this.term.write(data, () => this.changed()));
		io.onData((chunk) => this.keys.feed(chunk));
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
		if (this.sync && this.unanswered >= SYNC_WINDOW) return;
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
			bytes += SYNC;
			this.unanswered++;
			clearTimeout(this.answerTimer);
			this.answerTimer = setTimeout(() => this.answered(true), SYNC_TIMEOUT_MS);
		}
		this.io.write(bytes);
		this.lastFrame = Date.now();
	}

	private answered(timedOut: boolean): void {
		if (this.unanswered === 0) return;
		clearTimeout(this.answerTimer);
		if (timedOut) {
			// a terminal that stops answering gets frames without the request
			this.sync = false;
			this.unanswered = 0;
		} else {
			this.unanswered--;
			if (this.unanswered > 0) this.answerTimer = setTimeout(() => this.answered(true), SYNC_TIMEOUT_MS);
		}
		if (this.dirty) this.schedule();
	}

	/** The program's title on the right, as the footer sits in pi-vt420, and Alt while the meta key is pending. */
	private statusCells(): number[] {
		const columns = this.io.caps.columns;
		const left = this.keys.metaPending ? this.charset.cells(" Alt", ATTR_BOLD) : [];
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
