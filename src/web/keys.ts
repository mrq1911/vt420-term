/**
 * A PC keyboard as the VT420's: the LK401's keys where the PC has them, the rest as the VT420's own PC keyboard
 * (LK443) reaches them, Shift (or Alt) with F1-F10 for F11-F20.
 *
 *   F1-F4                    PF1-PF4 (and Num Lock / * - on the keypad, as on the LK443)
 *   F6-F12                   F6-F12
 *   Shift or Alt + F1-F10    F11, F12, F13, F14, Help, Do, F17, F18, F19, F20
 *   Ctrl + F-key             that key with the LK401's Shift: a user-defined key
 *   Ctrl + F1, F3            Hold Screen and Set-Up; Scroll Lock and Pause hold the screen too, Menu opens Set-Up
 *   Insert Delete Home End PgUp PgDn    Insert Here, Remove, Find, Select, Prev Screen, Next Screen
 *   keypad + and Alt+keypad -           the keypad's comma and minus
 */

import type { KeyName, KeyPress } from "../emu/keyboard.ts";

export type Local = "hold" | "setup" | "fullscreen" | "copy" | "paste" | "break";

export type Mapped = { press: KeyPress } | { local: Local } | undefined;

/** The LK401's top-row keys from F11 on, which Shift (or Alt) with F1-F10 reach. */
const UPPER: readonly KeyName[] = ["F11", "F12", "F13", "F14", "Help", "Do", "F17", "F18", "F19", "F20"];

const NAMED: Readonly<Record<string, KeyName>> = {
	Insert: "Insert",
	Delete: "Remove",
	Home: "Find",
	End: "Select",
	PageUp: "Prev",
	PageDown: "Next",
	ArrowUp: "Up",
	ArrowDown: "Down",
	ArrowLeft: "Left",
	ArrowRight: "Right",
	Enter: "Return",
	NumpadEnter: "KPEnter",
	Backspace: "Backspace",
	Tab: "Tab",
	Escape: "Escape",
	NumLock: "PF1",
	NumpadDivide: "PF2",
	NumpadMultiply: "PF3",
	Numpad0: "KP0",
	Numpad1: "KP1",
	Numpad2: "KP2",
	Numpad3: "KP3",
	Numpad4: "KP4",
	Numpad5: "KP5",
	Numpad6: "KP6",
	Numpad7: "KP7",
	Numpad8: "KP8",
	Numpad9: "KP9",
	NumpadDecimal: "KPPeriod",
	NumpadComma: "KPComma",
};

export function mapKey(event: KeyboardEvent, keypadApplication: boolean): Mapped {
	const { code, ctrlKey: ctrl, shiftKey: shift } = event;
	const altGraph = event.getModifierState("AltGraph");
	const alt = event.altKey && !altGraph;
	if (alt && code === "Enter") return { local: "fullscreen" };
	if (ctrl && shift && code === "KeyC") return { local: "copy" };
	if (ctrl && shift && code === "KeyV") return { local: "paste" };
	if (code === "ScrollLock" || code === "Pause") return { local: "hold" };
	if (code === "ContextMenu") return { local: "setup" };
	const fn = /^F(\d+)$/.exec(code);
	if (fn) return functionKey(Number(fn[1]), ctrl, shift, alt);
	if (code === "NumpadSubtract") return { press: { key: alt ? "KPMinus" : "PF4" } };
	if (code === "NumpadAdd") return { press: { key: keypadApplication ? "KPComma" : "+" } };
	const named = NAMED[code] ?? NAMED[event.key];
	if (named) return { press: { key: named, shift, ctrl, alt } };
	const key = event.key;
	if ([...key].length !== 1) return undefined;
	// AltGr types its character; Ctrl with it is no control
	return { press: { key, ctrl: ctrl && !altGraph, alt, shift } };
}

function functionKey(n: number, ctrl: boolean, shift: boolean, alt: boolean): Mapped {
	if (ctrl && !shift && !alt) {
		if (n === 1) return { local: "hold" };
		if (n === 3) return { local: "setup" };
		if (n === 5) return { local: "break" };
		if (n >= 6) return { press: { key: `F${n}`, shift: true } };
		return undefined;
	}
	const upper = (shift || alt) && n <= 10;
	if (upper) return { press: { key: UPPER[n - 1]!, shift: ctrl } };
	if (n <= 4) return { press: { key: `PF${n}` } };
	if (n === 5) return undefined;
	return { press: { key: `F${n}`, shift: ctrl } };
}
