/**
 * The page: the terminal between the program (over a WebSocket) and the screen and keyboard.
 */

import { type KeyPress, keyBytes, pastedBytes } from "../emu/keyboard.ts";
import { FACTORY_SETUP, latin1Bytes, RECOMMENDED_SETUP, Vt420, type Vt420Setup } from "../emu/vt420.ts";
import { mapKey } from "./keys.ts";
import { type Glide, Renderer, type Selection } from "./render.ts";
import { DEFAULT_DISPLAY, type DisplaySettings, SetupScreen } from "./setup.ts";
import { Sound } from "./sound.ts";

/** Above this much waiting, the program is held; below the second it goes on. */
const HOLD_BYTES = 64 * 1024;
const RELEASE_BYTES = 16 * 1024;

/** The Set-Up the page starts from until one is saved: the recommended one, with autowrap for a shell's long lines. */
const PAGE_SETUP: Vt420Setup = { ...RECOMMENDED_SETUP, autowrap: true };

const SETUP_KEY = "vt420.setup";
const DISPLAY_KEY = "vt420.display";

function stored<T>(name: string): Partial<T> {
	try {
		return JSON.parse(localStorage.getItem(name) ?? "{}") as Partial<T>;
	} catch {
		return {};
	}
}

class Page {
	readonly term: Vt420;
	readonly renderer: Renderer;
	display: DisplaySettings;
	private readonly socket: WebSocket;
	private readonly sound = new Sound();
	private readonly input: HTMLTextAreaElement;
	private queue: Uint8Array[] = [];
	private offset = 0;
	private queued = 0;
	private paused = false;
	private replaying = false;
	private hold = false;
	private glide: Glide | undefined;
	private selection: Selection | undefined;
	private selecting: { row: number; col: number } | undefined;
	private setupScreen: SetupScreen | undefined;
	private carry = 0;
	private last = performance.now();
	private exited: number | undefined;

	constructor(socket: WebSocket, setup: Partial<Vt420Setup>, display: Partial<DisplaySettings>) {
		this.socket = socket;
		this.display = { ...DEFAULT_DISPLAY, ...stored<DisplaySettings>(DISPLAY_KEY), ...display };
		this.term = new Vt420({
			setup: { ...PAGE_SETUP, ...stored<Vt420Setup>(SETUP_KEY), ...setup },
			utf8: this.display.utf8,
			onResponse: (bytes) => {
				if (!this.replaying) this.send(bytes);
			},
			onBell: () => {
				if (!this.replaying && this.display.bell) this.sound.bell();
			},
			onResize: (columns, lines) => {
				if (this.renderer) {
					this.renderer.invalidate();
					this.scanlines();
				}
				if (!this.replaying) this.message({ type: "resize", columns, lines });
			},
		});
		const canvas = document.querySelector<HTMLCanvasElement>("#screen")!;
		this.renderer = new Renderer(canvas, this.term);
		this.renderer.setPhosphor(this.display.phosphor);
		this.input = document.querySelector<HTMLTextAreaElement>("#keyboard")!;
		this.listen(canvas);
		this.fit();
		requestAnimationFrame((now) => this.frame(now));
		// a page in the background gets no frames; what comes meanwhile is taken in at once
		setInterval(() => {
			if (document.hidden && !this.setupScreen) this.take(Number.POSITIVE_INFINITY, false);
		}, 250);
	}

	start(): void {
		this.message({ type: "ready", columns: this.term.columns, lines: this.term.visibleLines });
	}

	received(data: Uint8Array): void {
		if (this.replaying) {
			this.term.feed(data);
			return;
		}
		this.queue.push(data);
		this.queued += data.length;
		this.flow();
	}

	control(message: { type: string; code?: number }): void {
		switch (message.type) {
			case "replay":
				// what the program wrote while no page showed it, drawn again without answering it twice
				this.replaying = true;
				this.term.powerUp();
				break;
			case "live":
				this.replaying = false;
				this.renderer.invalidate();
				break;
			case "exit":
				this.exited = message.code ?? 0;
				this.notice(
					`The program has ended${this.exited ? ` (${this.exited})` : ""}. Close the window, or reload for a new one.`,
				);
				break;
			case "taken":
				this.notice("Another window is the terminal now.");
				break;
		}
	}

	/** A line under the screen; one already there stays unless `replace`. */
	notice(text: string, replace = true): void {
		const notice = document.querySelector<HTMLElement>("#notice")!;
		if (!notice.hidden && !replace) return;
		notice.textContent = text;
		notice.hidden = false;
	}

	private message(message: object): void {
		if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
	}

	private send(bytes: string): void {
		if (this.exited !== undefined || this.socket.readyState !== WebSocket.OPEN) return;
		this.socket.send(latin1Bytes(bytes));
	}

	/** Bytes typed: to the program, and with local echo onto the screen as well. */
	private type(bytes: string): void {
		this.send(bytes);
		if (this.term.localEcho) this.received(latin1Bytes(bytes));
	}

	private flow(): void {
		if (!this.paused && this.queued > HOLD_BYTES) {
			this.paused = true;
			this.message({ type: "pause" });
		} else if (this.paused && this.queued < RELEASE_BYTES) {
			this.paused = false;
			this.message({ type: "resume" });
		}
	}

	/** Take in up to `budget` bytes, stopping at a scroll to glide when `glide`. */
	private take(budget: number, glide: boolean): void {
		while (this.queue.length > 0 && budget > 0 && !this.hold && !this.glide) {
			const chunk = this.queue[0]!;
			const end = Math.min(chunk.length, this.offset + budget);
			const next = this.term.write(chunk, this.offset, end, glide);
			budget -= next - this.offset;
			this.queued -= next - this.offset;
			this.offset = next;
			if (this.offset >= chunk.length) {
				this.queue.shift();
				this.offset = 0;
			}
			const event = this.term.smoothScrollEvent;
			if (event) {
				if (glide) this.glide = { event, start: performance.now(), duration: 1000 / this.display.smoothRate };
				else this.term.smoothScrollEvent = undefined;
			}
		}
		this.flow();
	}

	private frame(now: number): void {
		const elapsed = Math.min(100, now - this.last);
		this.last = now;
		if (this.glide && now - this.glide.start >= this.glide.duration) {
			this.glide = undefined;
			this.term.smoothScrollEvent = undefined;
			this.renderer.invalidate();
		}
		let budget = Number.POSITIVE_INFINITY;
		if (this.display.baud > 0) {
			this.carry += (this.display.baud / 10) * (elapsed / 1000);
			budget = Math.floor(this.carry);
			this.carry -= budget;
			if (this.queue.length === 0) this.carry = Math.min(this.carry, 1);
		}
		// in Set-Up the terminal takes nothing in, as the VT420 holds the line meanwhile
		if (!this.setupScreen) this.take(budget, true);
		this.renderer.draw(now, {
			glide: this.setupScreen ? undefined : this.glide,
			indicator: this.indicator(),
			selection: this.selection,
			cursorStyle: this.display.cursorStyle,
			cursorBlink: this.display.cursorBlink,
		});
		requestAnimationFrame((next) => this.frame(next));
	}

	/** The indicator status line: the printer, what holds the keyboard or the screen, and where the cursor is. */
	private indicator(): string {
		const term = this.term;
		const flags = [
			this.setupScreen ? "Set-Up" : "",
			this.hold ? "Hold Screen" : "",
			term.keyboardLocked ? "Wait" : "",
		]
			.filter(Boolean)
			.join("  ");
		const where = `Page ${term.page + 1}   Ln ${term.row + 1}, Col ${term.col + 1}  `;
		const left = ` Printer: None    ${flags}`;
		return left + where.padStart(term.columns - left.length);
	}

	private fit(): void {
		const resize = (): void => {
			this.renderer.resize();
			this.scanlines();
		};
		new ResizeObserver(resize).observe(this.renderer.canvas);
		resize();
	}

	/** The gaps between scan lines at the pitch of the dots a character row has. */
	private scanlines(): void {
		const box = this.renderer.canvas.getBoundingClientRect();
		const { rowHeight, top } = this.renderer.rows(box.height);
		const lines = this.renderer.term.screenLines;
		let pitch = rowHeight / (lines === 24 ? 16 : lines === 36 ? 10 : 8);
		while (pitch < 2.5) pitch *= 2;
		const scan = document.querySelector<HTMLElement>("#scanlines")!;
		scan.style.setProperty("--scan", `${pitch}px`);
		scan.style.backgroundPosition = `0 ${top}px`;
	}

	private listen(canvas: HTMLCanvasElement): void {
		const input = this.input;
		const focus = (): void => input.focus({ preventScroll: true });
		focus();
		window.addEventListener("focus", focus);
		input.addEventListener("keydown", (event) => this.key(event));
		input.addEventListener("paste", (event) => {
			event.preventDefault();
			const text = event.clipboardData?.getData("text") ?? "";
			if (text !== "" && !this.setupScreen) this.type(pastedBytes(this.term, text, { utf8: this.display.utf8 }));
		});
		// composed characters and input methods arrive as text rather than keys
		input.addEventListener("input", () => {
			const text = input.value;
			input.value = "";
			if (text !== "" && !this.setupScreen) this.type(pastedBytes(this.term, text, { utf8: this.display.utf8 }));
		});
		canvas.addEventListener("mousedown", (event) => {
			this.selecting = this.renderer.cellAt(event.clientX, event.clientY);
			this.selection = undefined;
			event.preventDefault();
			focus();
		});
		canvas.addEventListener("dblclick", (event) => {
			const cell = this.renderer.cellAt(event.clientX, event.clientY);
			if (cell) this.selectWord(cell);
		});
		window.addEventListener("mousemove", (event) => {
			if (!this.selecting || !(event.buttons & 1)) return;
			const cell = this.renderer.cellAt(event.clientX, event.clientY);
			if (cell) this.selection = ordered(this.selecting, cell);
		});
		window.addEventListener("mouseup", () => {
			this.selecting = undefined;
			if (this.selection) void this.copy();
		});
	}

	private key(event: KeyboardEvent): void {
		const mapped = mapKey(event, this.term.keypadApplication);
		if (!mapped) return;
		if ("local" in mapped) {
			if (mapped.local === "paste") return;
			event.preventDefault();
			this.local(mapped.local);
			return;
		}
		event.preventDefault();
		if (this.setupScreen) this.setupScreen.key(mapped.press);
		else this.press(mapped.press);
	}

	private press(press: KeyPress): void {
		if (this.exited !== undefined) return;
		const bytes = keyBytes(this.term, press, { altMeta: this.display.altMeta, utf8: this.display.utf8 });
		if (bytes === undefined) return;
		this.selection = undefined;
		if (this.display.keyclick) this.sound.click();
		this.type(bytes);
	}

	private local(action: string): void {
		switch (action) {
			case "hold":
				this.hold = !this.hold;
				return;
			case "setup":
				if (this.setupScreen) this.leaveSetup();
				else this.enterSetup();
				return;
			case "fullscreen":
				if (document.fullscreenElement) void document.exitFullscreen();
				else {
					void document.documentElement.requestFullscreen().then(() => {
						// with the keyboard locked Ctrl+W and the like reach the program
						const keyboard = (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard;
						void keyboard?.lock?.().catch(() => undefined);
					});
				}
				return;
			case "copy":
				void this.copy();
				return;
		}
	}

	private enterSetup(): void {
		this.selection = undefined;
		this.setupScreen = new SetupScreen({
			target: this.term,
			display: this.display,
			changed: () => this.renderer.setPhosphor(this.display.phosphor),
			save: () => {
				localStorage.setItem(SETUP_KEY, JSON.stringify(this.term.setup));
				localStorage.setItem(DISPLAY_KEY, JSON.stringify(this.display));
			},
			recall: (factory) => {
				this.term.setup = factory ? { ...FACTORY_SETUP } : { ...PAGE_SETUP, ...stored<Vt420Setup>(SETUP_KEY) };
				this.term.powerUp();
				Object.assign(this.display, DEFAULT_DISPLAY, factory ? {} : stored<DisplaySettings>(DISPLAY_KEY));
				this.renderer.setPhosphor(this.display.phosphor);
			},
			exit: () => this.leaveSetup(),
		});
		this.renderer.term = this.setupScreen.term;
		this.renderer.invalidate();
		this.scanlines();
	}

	private leaveSetup(): void {
		this.setupScreen = undefined;
		this.renderer.term = this.term;
		this.renderer.invalidate();
		this.scanlines();
	}

	private async copy(): Promise<void> {
		const selection = this.selection;
		if (!selection) return;
		const rows: string[] = [];
		for (let row = selection.from.row; row <= selection.to.row; row++) {
			const line = this.renderer.lineAt(row, this.indicator());
			if (!line) continue;
			const width = line.lineAttr === 0 ? this.term.columns : this.term.columns >> 1;
			const from = row === selection.from.row ? selection.from.col : 0;
			const to = row === selection.to.row ? selection.to.col : width - 1;
			rows.push(
				line.chars
					.slice(from, to + 1)
					.join("")
					.replace(/\s+$/u, ""),
			);
		}
		const text = rows.join("\n");
		if (text !== "") await navigator.clipboard.writeText(text).catch(() => undefined);
	}

	private selectWord(cell: { row: number; col: number }): void {
		const line = this.renderer.lineAt(cell.row, this.indicator());
		if (!line) return;
		const isWord = (col: number): boolean => /\S/u.test(line.chars[col] ?? " ");
		if (!isWord(cell.col)) return;
		let from = cell.col;
		let to = cell.col;
		while (from > 0 && isWord(from - 1)) from--;
		while (to < line.chars.length - 1 && isWord(to + 1)) to++;
		this.selection = { from: { row: cell.row, col: from }, to: { row: cell.row, col: to } };
		void this.copy();
	}
}

function ordered(a: { row: number; col: number }, b: { row: number; col: number }): Selection {
	return a.row < b.row || (a.row === b.row && a.col <= b.col) ? { from: a, to: b } : { from: b, to: a };
}

async function main(): Promise<void> {
	await document.fonts.load("40px VT323").catch(() => undefined);
	const token = new URLSearchParams(location.search).get("t") ?? "";
	const socket = new WebSocket(`ws://${location.host}/ws?t=${encodeURIComponent(token)}`);
	socket.binaryType = "arraybuffer";
	let page: Page | undefined;
	socket.addEventListener("message", (event) => {
		if (typeof event.data !== "string") {
			page?.received(new Uint8Array(event.data as ArrayBuffer));
			return;
		}
		const message = JSON.parse(event.data) as {
			type: string;
			setup?: Partial<Vt420Setup>;
			display?: Partial<DisplaySettings>;
			code?: number;
		};
		if (message.type === "hello") {
			page ??= new Page(socket, message.setup ?? {}, message.display ?? {});
			page.start();
			return;
		}
		page?.control(message);
	});
	socket.addEventListener("close", () => {
		page?.notice("The connection to vt420 is gone.", false);
	});
}

void main();
