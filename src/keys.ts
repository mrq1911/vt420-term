/**
 * Keyboard input from the terminal for a program that expects xterm. Bytes pass through as they are except where
 * the LK401 differs: F11, F12 and F13 are Escape, BS and LF as in VT100 mode (the LK401 has no Escape key); Do is
 * F5, a code the LK401 never sends, its F5 being the local Break key; F14 to F20, Help among them, are sent as xterm
 * sends them, as Shift with F2 to F8, so programs and zellij can bind them; Find and Select are Home and End; cursor and
 * keypad keys follow the program's modes, the keypad itself being kept in
 * application mode so its keys stay apart from the main digits; 8-bit supplemental characters become Unicode; a meta
 * key sends the next key with Alt, which the LK401 cannot type, and pressed twice sends itself; and the terminal's
 * answers to the adapter's own requests never reach the program.
 */

import { StringDecoder } from "node:string_decoder";
import { decodeGR, type SupplementalSet } from "./vt420/charset.ts";

export interface KeyModes {
	applicationCursorKeys: boolean;
	applicationKeypad: boolean;
}

export interface KeyTranslatorOptions {
	/** Bytes for the program, as a string of Unicode characters. */
	send(bytes: string): void;
	/** The terminal answered a device status or attributes request. */
	answered(): void;
	modes(): KeyModes;
	supplemental(): SupplementalSet;
	/** The terminal sends UTF-8 rather than DEC 8-bit characters. */
	unicode(): boolean;
	/** Function key that puts ESC before the next key, such as "f14". */
	metaKey?: string;
	metaChanged?(pending: boolean): void;
	/** How long a lone ESC waits for the rest of a sequence. */
	escapeTimeoutMs?: number;
}

const TILDE_NAMES: Record<number, string> = {
	17: "f6",
	18: "f7",
	19: "f8",
	20: "f9",
	21: "f10",
	23: "f11",
	24: "f12",
	25: "f13",
	26: "f14",
	28: "help",
	29: "do",
	31: "f17",
	32: "f18",
	33: "f19",
	34: "f20",
};

/** F14 to F20 as xterm sends them, Shift with F2 to F8; Help is F15, xterm's Shift+F3. */
const XTERM_SHIFTED: Record<number, (modifier: number) => string> = {
	26: (modifier) => `\x1b[1;${modifier}Q`,
	28: (modifier) => `\x1b[1;${modifier}R`,
	31: (modifier) => `\x1b[15;${modifier}~`,
	32: (modifier) => `\x1b[17;${modifier}~`,
	33: (modifier) => `\x1b[18;${modifier}~`,
	34: (modifier) => `\x1b[19;${modifier}~`,
};

/** Keypad keys in application mode and what they type in numeric mode. */
const KEYPAD: Record<string, string> = {
	p: "0",
	q: "1",
	r: "2",
	s: "3",
	t: "4",
	u: "5",
	v: "6",
	w: "7",
	x: "8",
	y: "9",
	m: "-",
	l: ",",
	n: ".",
	M: "\r",
	j: "*",
	k: "+",
	o: "/",
};

type State = "ground" | "escape" | "csi" | "ss3" | "string" | "stringEscape";

/**
 * After a lone ESC the next key waits this long, so the program reads Escape alone rather than as Alt with that key;
 * zellij gives a lone ESC 50 ms.
 */
const ESCAPE_GAP_MS = 80;

export class KeyTranslator {
	private readonly options: KeyTranslatorOptions;
	private readonly utf8 = new StringDecoder("utf8");
	private state: State = "ground";
	private sequence = "";
	private text = "";
	private meta = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private gapUntil = 0;
	private held = "";
	private gapTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: KeyTranslatorOptions) {
		this.options = options;
	}

	get metaPending(): boolean {
		return this.meta;
	}

	feed(chunk: Uint8Array): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		const unicode = this.options.unicode();
		for (const byte of chunk) this.byte(byte, unicode);
		this.flushText();
		if (this.state === "escape") {
			this.timer = setTimeout(() => {
				this.state = "ground";
				this.send("\x1b");
			}, this.options.escapeTimeoutMs ?? 50);
		}
	}

	dispose(): void {
		clearTimeout(this.timer);
		clearTimeout(this.gapTimer);
	}

	private byte(byte: number, unicode: boolean): void {
		switch (this.state) {
			case "ground":
				this.ground(byte, unicode);
				return;
			case "escape":
				this.escape(byte);
				return;
			case "csi":
				if (byte === 0x1b) {
					this.state = "escape";
					return;
				}
				this.sequence += String.fromCharCode(byte);
				if (byte >= 0x40 && byte <= 0x7e) {
					this.state = "ground";
					this.csi(this.sequence);
				}
				return;
			case "ss3":
				this.state = "ground";
				this.ss3(String.fromCharCode(byte));
				return;
			case "string":
				if (byte === 0x1b) this.state = "stringEscape";
				else if (byte === 0x9c || byte === 0x07) this.state = "ground";
				return;
			case "stringEscape":
				this.state = byte === 0x5c ? "ground" : "string";
				return;
		}
	}

	private ground(byte: number, unicode: boolean): void {
		if (byte === 0x1b) {
			this.flushText();
			this.state = "escape";
			return;
		}
		if (unicode) {
			this.text += this.utf8.write(Buffer.of(byte));
			return;
		}
		if (byte === 0x9b || byte === 0x8f) {
			this.flushText();
			this.state = byte === 0x9b ? "csi" : "ss3";
			this.sequence = "";
			return;
		}
		if (byte === 0x90 || byte === 0x9d || byte === 0x9e || byte === 0x9f || byte === 0x98) {
			this.flushText();
			this.state = "string";
			return;
		}
		if (byte >= 0x80 && byte < 0xa0) return;
		if (byte >= 0xa0) {
			this.text += decodeGR(byte, this.options.supplemental()) ?? "";
			return;
		}
		this.text += String.fromCharCode(byte);
	}

	private escape(byte: number): void {
		const char = String.fromCharCode(byte);
		if (char === "[") {
			this.state = "csi";
			this.sequence = "";
		} else if (char === "O") {
			this.state = "ss3";
		} else if (char === "P" || char === "]" || char === "^" || char === "_" || char === "X") {
			this.state = "string";
		} else if (byte === 0x1b) {
			this.send("\x1b");
		} else {
			// ESC and a character: Meta from an emulator's Alt key
			this.state = "ground";
			this.send(`\x1b${char}`);
		}
	}

	private csi(sequence: string): void {
		const final = sequence.at(-1)!;
		const body = sequence.slice(0, -1);
		// answers to the adapter's own requests
		if ((final === "c" && body.startsWith("?")) || (final === "n" && (body === "0" || body === "3"))) {
			this.options.answered();
			return;
		}
		if (final === "y" && body.endsWith("$")) return;
		if (body === "" && "ABCDHF".includes(final)) {
			this.send(this.cursorKey(final));
			return;
		}
		if (final === "~" && /^\d+$/.test(body)) {
			const code = Number(body);
			const name = TILDE_NAMES[code];
			// the meta key pressed twice is itself
			if (name && name === this.options.metaKey && !this.takeMeta()) {
				this.setMeta(true);
				return;
			}
			const shifted = XTERM_SHIFTED[code];
			// with meta pending, Shift and Alt
			if (shifted) this.deliver(shifted(this.takeMeta() ? 4 : 2));
			else if (code === 1) this.send(this.cursorKey("H"));
			else if (code === 4) this.send(this.cursorKey("F"));
			else if (code === 23) this.send("\x1b");
			else if (code === 24) this.send("\b");
			else if (code === 25) this.send("\n");
			else if (code === 29) this.send(this.takeMeta() ? "\x1b[15;3~" : "\x1b[15~");
			else if (this.takeMeta()) this.deliver(`\x1b[${code};3~`);
			else this.send(`\x1b[${sequence}`);
			return;
		}
		this.send(`\x1b[${sequence}`);
	}

	private ss3(char: string): void {
		if ("ABCDHF".includes(char)) {
			this.send(this.cursorKey(char));
			return;
		}
		// PF1 to PF4 are xterm's F1 to F4, which take Alt as a parameter
		if ("PQRS".includes(char) && this.takeMeta()) {
			this.deliver(`\x1b[1;3${char}`);
			return;
		}
		const typed = KEYPAD[char];
		if (typed !== undefined && !this.options.modes().applicationKeypad) {
			this.send(typed);
			return;
		}
		this.send(`\x1bO${char}`);
	}

	/** A cursor key in the program's mode; with meta pending, xterm's Alt modifier. */
	private cursorKey(final: string): string {
		if (this.takeMeta()) return `\x1b[1;3${final}`;
		return this.options.modes().applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`;
	}

	private flushText(): void {
		if (this.text === "") return;
		const text = this.text;
		this.text = "";
		this.send(text);
	}

	/** Bytes for the program; with meta pending, ESC goes first, which is how xterm sends Alt with a key. */
	private send(bytes: string): void {
		this.deliver(this.takeMeta() ? `\x1b${bytes}` : bytes);
	}

	private deliver(bytes: string): void {
		if (this.held !== "" || Date.now() < this.gapUntil) {
			this.held += bytes;
			this.gapTimer ??= setTimeout(() => this.release(), Math.max(0, this.gapUntil - Date.now()));
			return;
		}
		this.options.send(bytes);
		if (bytes === "\x1b") this.gapUntil = Date.now() + ESCAPE_GAP_MS;
	}

	private release(): void {
		this.gapTimer = undefined;
		const held = this.held;
		this.held = "";
		this.gapUntil = 0;
		if (held !== "") this.deliver(held);
	}

	private takeMeta(): boolean {
		if (!this.meta) return false;
		this.setMeta(false);
		return true;
	}

	private setMeta(pending: boolean): void {
		if (this.meta === pending) return;
		this.meta = pending;
		this.options.metaChanged?.(pending);
	}
}
