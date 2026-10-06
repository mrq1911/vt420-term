/**
 * What the VT420's keys send (Chapter 3 of the programmer reference), in whatever modes the terminal is in.
 */

import { nationalByte, supplementalByte } from "./charsets.ts";
import type { Vt420 } from "./vt420.ts";

/** The LK401's keys that are not characters; F15 is Help and F16 is Do. */
export type KeyName =
	| "PF1"
	| "PF2"
	| "PF3"
	| "PF4"
	| "F6"
	| "F7"
	| "F8"
	| "F9"
	| "F10"
	| "F11"
	| "F12"
	| "F13"
	| "F14"
	| "Help"
	| "Do"
	| "F17"
	| "F18"
	| "F19"
	| "F20"
	| "Find"
	| "Insert"
	| "Remove"
	| "Select"
	| "Prev"
	| "Next"
	| "Up"
	| "Down"
	| "Left"
	| "Right"
	| "Return"
	| "Backspace"
	| "Tab"
	| "Escape"
	| "KP0"
	| "KP1"
	| "KP2"
	| "KP3"
	| "KP4"
	| "KP5"
	| "KP6"
	| "KP7"
	| "KP8"
	| "KP9"
	| "KPMinus"
	| "KPComma"
	| "KPPeriod"
	| "KPEnter";

export interface KeyPress {
	/** A KeyName, or the character a typewriter key types. */
	key: KeyName | string;
	shift?: boolean;
	ctrl?: boolean;
	/** Alt, which the LK401 does not have: ESC before the key, as a meta key. */
	alt?: boolean;
}

export interface KeyboardOptions {
	/** Alt sends ESC before the key; otherwise it is ignored. */
	altMeta?: boolean;
	/** Characters typed as UTF-8, for a terminal set to decode it. */
	utf8?: boolean;
}

/** The DECUDK numbers and the codes of CSI n ~ of the top-row keys. */
const FUNCTION_KEYS: Readonly<Record<string, number>> = {
	F6: 17,
	F7: 18,
	F8: 19,
	F9: 20,
	F10: 21,
	F11: 23,
	F12: 24,
	F13: 25,
	F14: 26,
	Help: 28,
	Do: 29,
	F17: 31,
	F18: 32,
	F19: 33,
	F20: 34,
};

const EDITING_KEYS: Readonly<Record<string, number>> = { Find: 1, Insert: 2, Remove: 3, Select: 4, Prev: 5, Next: 6 };

const ARROWS: Readonly<Record<string, string>> = { Up: "A", Down: "B", Right: "C", Left: "D" };

/** The keypad: what it types in numeric mode, and the final of SS3 in application mode. */
const KEYPAD: Readonly<Record<string, [string, string]>> = {
	KP0: ["0", "p"],
	KP1: ["1", "q"],
	KP2: ["2", "r"],
	KP3: ["3", "s"],
	KP4: ["4", "t"],
	KP5: ["5", "u"],
	KP6: ["6", "v"],
	KP7: ["7", "w"],
	KP8: ["8", "x"],
	KP9: ["9", "y"],
	KPMinus: ["-", "m"],
	KPComma: [",", "l"],
	KPPeriod: [".", "n"],
};

/** Ctrl with keys that are not letters (Table 3-7). */
const CONTROL_KEYS: Readonly<Record<string, string>> = {
	" ": "\x00",
	"2": "\x00",
	"@": "\x00",
	"3": "\x1b",
	"[": "\x1b",
	"4": "\x1c",
	"/": "\x1c",
	"\\": "\x1c",
	"5": "\x1d",
	"]": "\x1d",
	"6": "\x1e",
	"~": "\x1e",
	"^": "\x1e",
	"7": "\x1f",
	"?": "\x1f",
	_: "\x1f",
	"8": "\x7f",
};

/** The bytes a key sends, or undefined for a key that sends nothing in this state. */
export function keyBytes(term: Vt420, press: KeyPress, options: KeyboardOptions = {}): string | undefined {
	if (term.keyboardLocked) return undefined;
	const sent = keyBytesUnlocked(term, press, options);
	if (sent === undefined || !press.alt || !options.altMeta) return sent;
	return `\x1b${sent}`;
}

function keyBytesUnlocked(term: Vt420, press: KeyPress, options: KeyboardOptions): string | undefined {
	const { key } = press;
	const eight = term.eightBitControls && term.level > 1 && !term.vt52;
	const csi = eight ? "\x9b" : "\x1b[";
	const ss3 = eight ? "\x8f" : "\x1bO";
	if (key in FUNCTION_KEYS) return functionKey(term, key, press.shift === true, csi);
	if (key in EDITING_KEYS) return term.level > 1 && !term.vt52 ? `${csi}${EDITING_KEYS[key]}~` : undefined;
	if (key in ARROWS) {
		const final = ARROWS[key]!;
		if (term.vt52) return `\x1b${final}`;
		return term.cursorKeysApplication ? `${ss3}${final}` : `${csi}${final}`;
	}
	if (key.startsWith("PF") && key.length === 3) {
		const final = String.fromCharCode(0x50 + Number(key[2]) - 1);
		return term.vt52 ? `\x1b${final}` : `${ss3}${final}`;
	}
	if (key in KEYPAD) {
		const [numeric, application] = KEYPAD[key]!;
		if (!term.keypadApplication) return numeric;
		return term.vt52 ? `\x1b?${application}` : `${ss3}${application}`;
	}
	switch (key) {
		case "Return":
			return term.newLine ? "\r\n" : "\r";
		case "KPEnter":
			if (!term.keypadApplication) return term.newLine ? "\r\n" : "\r";
			return term.vt52 ? "\x1b?M" : `${ss3}M`;
		case "Backspace":
			return term.backarrowBS ? "\b" : "\x7f";
		case "Tab":
			return "\t";
		case "Escape":
			return "\x1b";
	}
	return typed(term, press, options);
}

function functionKey(term: Vt420, key: string, shift: boolean, csi: string): string | undefined {
	const number = FUNCTION_KEYS[key]!;
	if (term.level === 1 || term.vt52) {
		// in VT100 and VT52 modes F11-F13 are Escape, Backspace and Line feed, and the rest send nothing
		return { F11: "\x1b", F12: "\b", F13: "\n" }[key];
	}
	const defined = (shift ? term.udkShifted : term.udkUnshifted).get(number);
	if (defined !== undefined) return defined;
	return shift ? `${csi}${number};2~` : `${csi}${number}~`;
}

/** A typewriter key: its character, with Ctrl its control, in the set the terminal types. */
function typed(term: Vt420, press: KeyPress, options: KeyboardOptions): string | undefined {
	const char = press.key;
	if ([...char].length !== 1) return undefined;
	if (press.ctrl) {
		const lower = char.toLowerCase();
		if (lower >= "a" && lower <= "z") return String.fromCharCode(lower.charCodeAt(0) - 0x60);
		return CONTROL_KEYS[char];
	}
	const code = char.codePointAt(0)!;
	if (code < 0x80) {
		if (code < 0x20 || code === 0x7f) return undefined;
		if (term.national) {
			// a national set has its own characters where ASCII has # @ [ \ ] ^ _ ` { | } ~
			const byte = nationalByte(char, term.setup.nationalSet);
			return byte === undefined || byte === code ? char : undefined;
		}
		return char;
	}
	if (options.utf8) return utf8(char);
	if (term.national) {
		const byte = nationalByte(char, term.setup.nationalSet);
		return byte === undefined ? undefined : String.fromCharCode(byte);
	}
	if (term.level === 1) return undefined;
	const byte = supplementalByte(char, term.userPreferred);
	return byte === undefined ? undefined : String.fromCharCode(byte);
}

/** Text pasted or typed at once: Return for line ends, characters the terminal cannot type dropped. */
export function pastedBytes(term: Vt420, text: string, options: KeyboardOptions = {}): string {
	let out = "";
	for (const char of text.replace(/\r\n?/g, "\n")) {
		if (char === "\n") out += "\r";
		else if (char === "\t") out += "\t";
		else out += typed(term, { key: char }, options) ?? "";
	}
	return out;
}

function utf8(char: string): string {
	let out = "";
	for (const byte of new TextEncoder().encode(char)) out += String.fromCharCode(byte);
	return out;
}
