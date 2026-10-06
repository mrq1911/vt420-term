/**
 * The adapter: a program runs in a pseudo-terminal and believes it talks to xterm, xterm.js emulates that terminal
 * in memory, and the VT420 only ever sees what the renderer draws from the emulated screen. Frames are composed from
 * the latest state, so a program that floods its output costs the serial line no more than the screen it ends up
 * showing; they wait for synchronized updates to finish, and each ends with a DSR request (DA1 where the terminal
 * ignores DSR) so the terminal is never more than a frame behind, whatever it is still drawing.
 */

import { Unicode11Addon } from "@xterm/addon-unicode11";
import xterm from "@xterm/headless";
import { functionKeyBytes, KeyTranslator } from "./keys.ts";
import { activity, SAVER_MINUTES, SAVER_MOVE_MS, type SaverMode, saverFrame, saverPlace } from "./saver.ts";
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
	/** Bytes as they are, from the native session's program. */
	writeBytes(chunk: Uint8Array): void;
	/** The session's modes and designations again, keeping what the screen shows. */
	restoreModes(): void;
	/** What puts the terminal back as the session found it, then clears the screen. */
	originalState(): string;
	onData(listener: (chunk: Buffer) => void): void;
	onResize(handler: () => void): void;
}

/** The native session's program, on a pseudo-terminal of its own, whose bytes pass through as they are. */
export interface NativeChild {
	onData(listener: (data: Buffer) => void): unknown;
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
	write(data: string | Buffer): void;
	resize(columns: number, rows: number): void;
	pause(): void;
	resume(): void;
	kill(): void;
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
	/** How long answers may lag the time the frames out take before probes start, and the first probe's wait. */
	syncTimeoutMs?: number;
	/** Show the last key the terminal sent, and what the program got for it, on the status line. */
	showKeys?: boolean;
	/** The program gets a row more than the screen, and its last one shows on the status line, if there is one. */
	statusRow?: boolean;
	/** F11, F12 and F13 reach the program as function keys rather than Escape, BS and LF. */
	functionKeys?: boolean;
	/**
	 * Function key, such as "f19", that switches the terminal between the program and a native session, whose program,
	 * started by `spawnNative` on the first switch, draws on the terminal itself.
	 */
	nativeKey?: string;
	spawnNative?: () => NativeChild;
	/** Screen saver after a spell without keys; "auto" is "progress" on a DEC terminal and "off" on emulators. */
	screensaver?: SaverMode | "auto";
	screensaverMinutes?: number;
	saverMoveMs?: number;
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

/**
 * Pieces sent but not yet answered, at most; whole frames on an emulator. Two pieces and their requests are fewer bytes
 * than a VT420's input buffer of 254 holds, so nothing is lost whether or not anything on the way honours its XOFF.
 */
const SYNC_WINDOW = 2;
/** Line speed assumed for how long an answer may take when the real one is unknown: 9600 baud. */
const SYNC_BYTES_PER_SECOND = 960;
/** How long answers may lag what the frames out take, and the first probe's wait; each next one waits twice as long. */
const SYNC_TIMEOUT_MS = 1000;
/** The longest wait for a probe, in first waits. */
const SYNC_PROBE_MAX = 8;
/** Probes left unanswered before frames go out without answers, one window each time a probe does. */
const SYNC_PROBES_BLIND = 4;
/**
 * A DEC terminal gets a frame in pieces of at most this many bytes, each answered before the window lets more out,
 * so a whole screen never runs ahead of it: flow control that comes back over ssh comes too late to stop one.
 */
const SYNC_CHUNK = 96;

/** Pieces joined into runs of at most `max` characters; a longer piece stays whole. */
function chunks(parts: readonly string[], max: number): string[] {
	const out: string[] = [];
	let current = "";
	for (const part of parts) {
		if (current !== "" && current.length + part.length > max) {
			out.push(current);
			current = "";
		}
		current += part;
	}
	if (current !== "") out.push(current);
	return out;
}
/** How long a synchronized update may hold back frames before the screen is drawn anyway. */
const SYNCHRONIZED_HOLD_MS = 150;
/** The page of the terminal's page memory the native session draws on; the program's is page 1. */
const NATIVE_PAGE = 2;
/** How long the frames out may take to be answered, and the terminal's state reports to come, on a switch. */
const SWITCH_WAIT_MS = 2000;
/** How long the native side's input waits when it ends as the switch key could start. */
const NATIVE_KEY_WAIT_MS = 50;

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
	/** Bytes of each piece the terminal has not answered yet. */
	private unanswered: number[] = [];
	/** Pieces of the last frame still to go out. */
	private outbox: string[] = [];
	/** Ends each frame: DSR 5, whose answer is four bytes, or DA1 where DSR goes unanswered. */
	private sync: { bytes: string; answer: "status" | "attributes" } | undefined;
	/** Probes, DA1, out since answers stopped coming; while there are any, frames wait. */
	private stallProbes = 0;
	private readonly syncTimeoutMs: number;
	private lastFrame = 0;
	private heldSince: number | undefined;
	private cursorVisible = true;
	private title = "";
	private bell = false;
	private closed = false;
	private readonly showKeys: boolean;
	private readonly statusRow: boolean;
	private keyIn = "";
	private keyOut = "";
	private exited: Promise<number>;
	private readonly saver: SaverMode;
	private readonly saverMinutes: number;
	private readonly saverMoveMs: number;
	private saverTimer: ReturnType<typeof setTimeout> | undefined;
	private saverMoveTimer: ReturnType<typeof setInterval> | undefined;
	/** The screen saver is showing; the next key only wakes the screen. */
	private saving = false;
	private saverPlace = { row: 0, col: 0 };
	private changedAt = Date.now();
	/** Which side the terminal shows, and the switches between them. */
	private shown: "main" | "toNative" | "native" | "toMain" = "main";
	private readonly spawnNative: (() => NativeChild) | undefined;
	private readonly nativeKeys: string[];
	private native: NativeChild | undefined;
	/** Native output that came while the program's side showed, to go out on the way back. */
	private nativeHeld: Buffer[] = [];
	/** The terminal and cursor state the native program left, as the terminal reported them. */
	private nativeState: { terminal: string; cursor: string } | undefined;
	/** What came from the terminal while its state reports were awaited. */
	private reports = "";
	private reportTimer: ReturnType<typeof setTimeout> | undefined;
	/** The end of the native side's input, held while it could be the start of the switch key. */
	private nativePending = "";
	private nativePendingTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(io: SessionTerminal, child: SessionChild, options: SessionOptions = {}) {
		this.io = io;
		this.child = child;
		this.frameMs = options.frameMs ?? 16;
		this.showKeys = options.showKeys ?? false;
		this.spawnNative = options.nativeKey ? options.spawnNative : undefined;
		this.nativeKeys = this.spawnNative ? functionKeyBytes(options.nativeKey!) : [];
		const caps = io.caps;
		this.statusRow = (options.statusRow ?? false) && caps.statusLine;
		const saver = options.screensaver ?? "auto";
		this.saver = saver === "auto" ? (caps.unicode ? "off" : "progress") : saver;
		this.saverMinutes = options.screensaverMinutes ?? SAVER_MINUTES;
		this.saverMoveMs = options.saverMoveMs ?? SAVER_MOVE_MS;
		this.sync = caps.deviceStatus
			? { bytes: "\x1b[5n", answer: "status" }
			: caps.level > 0
				? { bytes: "\x1b[c", answer: "attributes" }
				: undefined;
		this.syncTimeoutMs = options.syncTimeoutMs ?? SYNC_TIMEOUT_MS;
		this.charset = new Charset({
			technical: caps.technical,
			supplemental: caps.supplemental,
			eightBit: caps.eightBit,
		});
		this.screen = new ScreenMapper(this.charset);
		this.renderer = rendererFor(caps);
		this.term = new xterm.Terminal({ cols: caps.columns, rows: this.rows(), allowProposedApi: true, scrollback: 0 });
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
				// the key that wakes the screen does nothing else
				if (this.saving) {
					this.wake();
					return;
				}
				this.armSaver();
				child.write(bytes);
				if (this.showKeys) {
					this.keyOut = visible(bytes);
					this.changed();
				}
			},
			answered: (kind) => {
				if (this.stallProbes > 0 && kind === "attributes") this.recovered();
				else if (kind === this.sync?.answer) this.answered();
			},
			modes: () => ({
				applicationCursorKeys: this.term.modes.applicationCursorKeysMode,
				applicationKeypad: this.term.modes.applicationKeypadMode,
			}),
			supplemental: () => this.io.caps.supplemental,
			unicode: () => this.io.caps.unicode,
			metaKey: options.metaKey === "none" ? undefined : (options.metaKey ?? "f14"),
			functionKeys: options.functionKeys ?? false,
			nativeKey: this.spawnNative ? options.nativeKey : undefined,
			native: () => this.toNative(),
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
		child.onData((data) =>
			this.term.write(data, () => {
				this.changedAt = Date.now();
				this.changed();
			}),
		);
		io.onData((chunk) => {
			if (this.shown === "native") {
				this.nativeInput(chunk);
				return;
			}
			if (this.shown === "toMain") {
				this.gatherReports(chunk);
				return;
			}
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
		this.armSaver();
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
		clearTimeout(this.saverTimer);
		clearInterval(this.saverMoveTimer);
		clearTimeout(this.reportTimer);
		clearTimeout(this.nativePendingTimer);
		this.native?.kill();
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
		// the native session has the terminal, or is taking it or giving it back
		if (this.closed || !this.dirty || this.shown !== "main") return;
		if (this.term.modes.synchronizedOutputMode) {
			this.heldSince ??= Date.now();
			if (Date.now() - this.heldSince < SYNCHRONIZED_HOLD_MS) {
				this.schedule(10);
				return;
			}
		}
		this.heldSince = undefined;
		// the answer to an earlier frame schedules this one
		if (this.outbox.length > 0 || this.held || this.unanswered.length >= SYNC_WINDOW) return;
		const caps = this.io.caps;
		const lines = this.saving ? [] : this.screen.lines(this.term);
		const cursor = this.saving ? undefined : this.screen.cursor(this.term, this.cursorVisible);
		const frame: Frame = this.saving
			? saverFrame(caps.rows, caps.columns, this.saverLine(), this.saverPlace, caps.statusLine)
			: {
					lines: lines.slice(0, caps.rows),
					status: caps.statusLine
						? this.statusCells(this.statusRow ? lines[caps.rows]?.cells : undefined)
						: undefined,
					// the program's cursor on the row the status line shows is not drawn
					cursor: cursor && cursor.row < caps.rows ? cursor : undefined,
					scroll: { top: 0, bottom: caps.rows - 1 },
				};
		this.dirty = false;
		const parts = this.renderer.renderParts(frame);
		if (this.bell) {
			parts.push("\x07");
			this.bell = false;
		}
		if (parts.length === 0) return;
		this.lastFrame = Date.now();
		if (!this.sync) {
			this.io.write(parts.join(""));
			return;
		}
		// an emulator takes a whole frame at once
		this.outbox = this.io.caps.unicode ? [parts.join("")] : chunks(parts, SYNC_CHUNK);
		this.pump();
	}

	/** Send waiting pieces while the window has room. */
	private pump(): void {
		while (this.sync && !this.held && this.outbox.length > 0 && this.unanswered.length < SYNC_WINDOW) {
			const bytes = this.outbox.shift()! + this.sync.bytes;
			this.unanswered.push(bytes.length);
			this.armAnswerTimer();
			this.io.write(bytes);
		}
	}

	/** The terminal answered after the oldest piece still out, so it has drawn that one. */
	private answered(): void {
		if (this.unanswered.length === 0) return;
		this.unanswered.shift();
		// a late answer: the rest may follow, else the probe's answer settles them
		if (this.stallProbes > 0 && this.unanswered.length > 0) return;
		this.stallProbes = 0;
		this.resume();
	}

	/** The probe came back: all that went out before it is drawn, and answers still missing were lost on the way. */
	private recovered(): void {
		this.stallProbes = 0;
		this.unanswered = [];
		this.resume();
	}

	private resume(): void {
		this.armAnswerTimer();
		this.pump();
		if (this.dirty && this.outbox.length === 0) this.schedule();
	}

	/** Waiting on a probe, with nothing to go out until it is answered. */
	private get held(): boolean {
		return this.stallProbes > 0 && this.stallProbes < SYNC_PROBES_BLIND;
	}

	/**
	 * Past the time the frames out could take, answers have stopped: lost on the way, or the terminal is held, in
	 * Set-Up, by Hold Screen or by flow control. Then only a probe goes out, less often each time, so a held terminal
	 * gets no backlog to wade through, or wedge the line with, once it goes on. One that answers no probe at all gets
	 * a window's worth now and then.
	 */
	private armAnswerTimer(): void {
		clearTimeout(this.answerTimer);
		this.answerTimer = undefined;
		if (this.unanswered.length === 0 && this.stallProbes === 0) return;
		const bytes = this.unanswered.reduce((sum, length) => sum + length, 0);
		const ms =
			this.stallProbes > 0
				? this.syncTimeoutMs * Math.min(SYNC_PROBE_MAX, 2 ** (this.stallProbes - 1))
				: this.syncTimeoutMs + (bytes * 1000) / (this.io.caps.bytesPerSecond ?? SYNC_BYTES_PER_SECOND);
		this.answerTimer = setTimeout(() => this.probe(), ms);
	}

	private probe(): void {
		this.answerTimer = undefined;
		if (!this.sync || this.closed) return;
		this.stallProbes++;
		this.io.write("\x1b[c");
		if (this.stallProbes >= SYNC_PROBES_BLIND) {
			this.unanswered = [];
			this.pump();
			if (this.dirty && this.outbox.length === 0) this.schedule();
		}
		this.armAnswerTimer();
	}

	/** Start the screen saver once the configured spell passes without a key. */
	private armSaver(): void {
		clearTimeout(this.saverTimer);
		this.saverTimer = undefined;
		if (this.saver === "off" || this.closed || this.shown !== "main") return;
		this.saverTimer = setTimeout(() => this.startSaver(), this.saverMinutes * 60_000);
	}

	private startSaver(): void {
		if (this.saving || this.closed || this.shown !== "main") return;
		this.saving = true;
		// a light screen would stay lit
		if (this.io.caps.screenReverse) this.io.write("\x1b[?5l");
		this.moveSaver();
		if (this.saver === "progress") this.saverMoveTimer = setInterval(() => this.moveSaver(), this.saverMoveMs);
	}

	private moveSaver(): void {
		const { rows, columns } = this.io.caps;
		this.saverPlace = saverPlace(rows, columns, this.saverLine()?.length ?? 0);
		this.changed();
	}

	private wake(): void {
		this.saving = false;
		clearInterval(this.saverMoveTimer);
		this.saverMoveTimer = undefined;
		if (this.io.caps.screenReverse) this.io.write("\x1b[?5h");
		this.armSaver();
		this.changed();
	}

	/** The progress saver's line: the program's title, and whether its screen still changes. */
	private saverLine(): number[] | undefined {
		if (this.saver !== "progress") return undefined;
		const name = this.title.trim() || "vt420-term";
		const line = this.charset.cells(`${name} · ${activity(Date.now() - this.changedAt)}`);
		return truncateCells(line, this.io.caps.columns, this.charset.cells("…"));
	}

	/**
	 * The pending Alt or the keys at the left; at the right the title, or the program's own row under it all. pi-vt420
	 * puts its footer in the title, π first, where it has no status line of its own; that shows instead, and over
	 * zellij's bar too while zellij is in normal mode, so pi has the status line as it does on the VT420 itself.
	 */
	private statusCells(row?: readonly number[]): number[] {
		const columns = this.io.caps.columns;
		const keys = this.showKeys && this.keyIn ? ` ${this.keyIn} > ${this.keyOut || "nothing"}` : "";
		const left = this.keys.metaPending ? this.charset.cells(" Alt", ATTR_BOLD) : keys ? this.charset.cells(keys) : [];
		// zellij passes the focused pane's title on as "session | title"
		const pi = /(?:^| \| )π (.+)$/.exec(this.title)?.[1];
		const normal = row !== undefined && this.statusRowText().includes("NORMAL");
		if (row && !(pi && normal)) {
			const base = [...row.slice(0, columns - 1), ...spaces(Math.max(0, columns - 1 - row.length))];
			const shown = truncateCells(left, columns - 1, []);
			return [
				...shown,
				...(shown.length > 0 ? [BLANK] : []),
				...base.slice(shown.length + (shown.length > 0 ? 1 : 0)),
				BLANK,
			];
		}
		const room = Math.max(0, columns - 2 - left.length - 1);
		const title = truncateCells(this.charset.cells(pi ?? this.title), room, this.charset.cells("…"));
		return [...left, ...spaces(columns - 1 - left.length - title.length), ...title, BLANK];
	}

	/** The text of the program's row under the screen, with `statusRow`. */
	private statusRowText(): string {
		const buffer = this.term.buffer.active;
		return buffer.getLine(buffer.viewportY + this.io.caps.rows)?.translateToString(true) ?? "";
	}

	/** Rows the program has: the screen's, and one for the status line with `statusRow`. */
	private rows(): number {
		return this.io.caps.rows + (this.statusRow ? 1 : 0);
	}

	private resize(): void {
		const { columns } = this.io.caps;
		const rows = this.rows();
		this.term.resize(columns, rows);
		this.child.resize(columns, rows);
		this.native?.resize(columns, this.io.caps.rows);
		this.renderer = rendererFor(this.io.caps);
		this.changed();
	}

	// ---------------------------------------------------------------------------------------------
	// The native session: a second program that draws on the terminal itself, on a page of the terminal's page memory
	// of its own, so the switch key flips between the two at once and each finds its screen as it left it. The
	// terminal reports its whole state (DECTSR) and the cursor's (DECCIR) when the native session gives the terminal
	// up, and gets them back (DECRSTS, DECRSPS) when it takes it again; only the status line, shared by the pages, is
	// drawn again, by the native program after a resize and by the renderer for the program.

	private toNative(): void {
		if (this.shown !== "main" || !this.spawnNative || this.closed) return;
		if (this.saving) this.wake();
		this.shown = "toNative";
		clearTimeout(this.saverTimer);
		const started = Date.now();
		const handOver = (): void => {
			if (this.closed) return;
			// the frames still out come first, else their answers would go to the native program
			if ((this.unanswered.length > 0 || this.outbox.length > 0) && Date.now() - started < SWITCH_WAIT_MS) {
				setTimeout(handOver, 20);
				return;
			}
			this.outbox = [];
			this.unanswered = [];
			this.stallProbes = 0;
			clearTimeout(this.answerTimer);
			const { columns, rows } = this.io.caps;
			this.io.write(
				this.nativeState
					? `\x1bP1$p${this.nativeState.terminal}\x1b\\\x1bP1$t${this.nativeState.cursor}\x1b\\`
					: `\x1b[${NATIVE_PAGE} P${this.io.originalState()}`,
			);
			this.shown = "native";
			if (!this.native) {
				this.startNative();
				return;
			}
			for (const data of this.nativeHeld.splice(0)) this.io.writeBytes(data);
			this.native.resume();
			// a resize has the program draw again, the status line with it
			this.native.resize(columns, rows - 1);
			setTimeout(() => this.native?.resize(columns, rows), 50);
		};
		handOver();
	}

	private startNative(): void {
		const native = this.spawnNative!();
		this.native = native;
		native.onData((data) => {
			if (this.shown === "native") this.io.writeBytes(data);
			else this.nativeHeld.push(data);
		});
		native.onExit(() => {
			if (this.native !== native) return;
			this.native = undefined;
			this.nativeState = undefined;
			this.nativeHeld = [];
			if (this.shown === "native") this.toMain();
		});
	}

	/** Keys and answers for the native program, as they come, but for the switch key. */
	private nativeInput(chunk: Buffer): void {
		clearTimeout(this.nativePendingTimer);
		const text = this.nativePending + chunk.toString("latin1");
		this.nativePending = "";
		let at = -1;
		let length = 0;
		for (const key of this.nativeKeys) {
			const index = text.indexOf(key);
			if (index >= 0 && (at < 0 || index < at)) {
				at = index;
				length = key.length;
			}
		}
		if (at >= 0) {
			this.toNativeProgram(text.slice(0, at));
			this.toMain();
			const rest = text.slice(at + length);
			if (rest && this.shown === "toMain") this.gatherReports(Buffer.from(rest, "latin1"));
			return;
		}
		// an end that could start the switch key waits a moment for the rest
		let keep = 0;
		for (const key of this.nativeKeys) {
			for (let size = Math.min(key.length - 1, text.length); size > keep; size--) {
				if (text.endsWith(key.slice(0, size))) {
					keep = size;
					break;
				}
			}
		}
		this.toNativeProgram(text.slice(0, text.length - keep));
		if (keep === 0) return;
		this.nativePending = text.slice(text.length - keep);
		this.nativePendingTimer = setTimeout(() => {
			const held = this.nativePending;
			this.nativePending = "";
			this.toNativeProgram(held);
		}, NATIVE_KEY_WAIT_MS);
	}

	private toNativeProgram(text: string): void {
		if (text) this.native?.write(Buffer.from(text, "latin1"));
	}

	/** The native session gives the terminal up: its output waits, and the terminal reports the state it leaves. */
	private toMain(): void {
		if (this.shown !== "native") return;
		this.native?.pause();
		if (!this.native) {
			this.showMain();
			return;
		}
		this.shown = "toMain";
		this.reports = "";
		this.io.write("\x1b[1$u\x1b[1$w");
		this.reportTimer = setTimeout(() => this.reportsDone(), SWITCH_WAIT_MS);
	}

	/** The state reports, kept apart from whatever else comes meanwhile, which is still the native program's. */
	private gatherReports(chunk: Buffer): void {
		this.reports += chunk.toString("latin1");
		const terminal = /(?:\x1bP|\x90)1\$s([^\x1b\x9c]*)(?:\x1b\\|\x9c)/.exec(this.reports);
		const cursor = /(?:\x1bP|\x90)1\$u([^\x1b\x9c]*)(?:\x1b\\|\x9c)/.exec(this.reports);
		if (terminal && cursor) this.reportsDone({ terminal: terminal[1]!, cursor: cursor[1]! });
	}

	/** Without the reports, the native session starts on a cleared page next time. */
	private reportsDone(state?: { terminal: string; cursor: string }): void {
		clearTimeout(this.reportTimer);
		this.nativeState = state;
		const rest = this.reports.replace(/(?:\x1bP|\x90)1\$[su][^\x1b\x9c]*(?:\x1b\\|\x9c)/g, "");
		this.reports = "";
		this.toNativeProgram(rest);
		this.showMain();
	}

	/** The program's page, its modes again, and whatever changed meanwhile drawn, the shared status line in full. */
	private showMain(): void {
		this.shown = "main";
		this.io.write("\x1b[1 P");
		this.io.restoreModes();
		this.renderer.forgetState();
		this.renderer.forgetStatus();
		this.changed();
		this.armSaver();
	}
}
