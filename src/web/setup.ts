/**
 * Set-Up, as the VT420 has it: a screen of its own, drawn by the terminal with its own control functions, that
 * changes how it works at once and keeps that for good when saved. Arrow keys move and change, Enter and Space
 * change or act, Ctrl+F3 or Escape leave.
 */

import type { CharsetId } from "../emu/charsets.ts";
import type { KeyPress } from "../emu/keyboard.ts";
import { RECOMMENDED_SETUP, Vt420, type Vt420Setup } from "../emu/vt420.ts";

/** What the page keeps beside the terminal's own Set-Up. */
export interface DisplaySettings {
	phosphor: "white" | "green" | "amber";
	cursorStyle: "block" | "underline";
	cursorBlink: boolean;
	/** Lines a second a smooth scroll glides. */
	smoothRate: number;
	keyclick: boolean;
	bell: boolean;
	/** Alt sends ESC before a key. */
	altMeta: boolean;
	/** Bytes from 0x80 are UTF-8. */
	utf8: boolean;
	/** The program's output taken in no faster than a line at this speed, 0 for no limit. */
	baud: number;
	/** How heavy the characters are drawn. */
	weight: "thin" | "medium" | "heavy";
	/** How long the phosphor glows once a dot goes dark. */
	persistence: "off" | "short" | "medium" | "long";
}

export const DEFAULT_DISPLAY: DisplaySettings = {
	phosphor: "white",
	cursorStyle: "block",
	cursorBlink: true,
	smoothRate: 9,
	keyclick: false,
	bell: true,
	altMeta: true,
	utf8: false,
	baud: 0,
	weight: "thin",
	persistence: "medium",
};

interface Item {
	label: string;
	values: readonly string[];
	get(): number;
	set(index: number): void;
}

interface Action {
	label: string;
	run(): void;
}

export interface SetupHost {
	target: Vt420;
	display: DisplaySettings;
	/** A display setting changed. */
	changed(): void;
	save(): void;
	/** The saved settings back, and the terminal reset to them; or with `factory`, the factory's. */
	recall(factory: boolean): void;
	exit(): void;
}

const NATIONAL: readonly [CharsetId, string][] = [
	["british", "British"],
	["finnish", "Finnish"],
	["french", "French"],
	["french-canadian", "French Canadian"],
	["german", "German"],
	["italian", "Italian"],
	["norwegian", "Norwegian/Danish"],
	["portuguese", "Portuguese"],
	["spanish", "Spanish"],
	["swedish", "Swedish"],
	["swiss", "Swiss"],
];

const SPEEDS = [0, 1200, 2400, 4800, 9600, 19200, 38400];
const RATES = [4.4, 9, 17.5];

export class SetupScreen {
	/** The screen Set-Up draws on. */
	readonly term = new Vt420({ setup: { ...RECOMMENDED_SETUP, statusDisplay: 1 } });
	private readonly host: SetupHost;
	private readonly left: Array<{ title: string; items: Item[] }>;
	private readonly right: Array<{ title: string; items: Item[] }>;
	private readonly actions: Action[];
	private selected = 0;
	private message = "";

	constructor(host: SetupHost) {
		this.host = host;
		const target = host.target;
		const display = host.display;
		const setup = (change: Partial<Vt420Setup>): void => {
			target.changeSetup(change);
		};
		const shown = (change: Partial<DisplaySettings>): void => {
			Object.assign(display, change);
			host.changed();
		};
		const choice = <const T>(
			label: string,
			values: readonly (readonly [T, string])[],
			get: () => T,
			set: (value: T) => void,
		): Item => ({
			label,
			values: values.map(([, name]) => name),
			get: () =>
				Math.max(
					0,
					values.findIndex(([value]) => value === get()),
				),
			set: (index) => set(values[index]![0]),
		});
		const toggle = (label: string, names: [string, string], get: () => boolean, set: (on: boolean) => void): Item =>
			choice(
				label,
				[
					[false, names[0]],
					[true, names[1]],
				],
				get,
				set,
			);
		this.left = [
			{
				title: "Display",
				items: [
					choice(
						"Columns",
						[
							[80, "80"],
							[132, "132"],
						],
						() => target.columns,
						(columns) => setup({ columns }),
					),
					choice(
						"Lines",
						[
							[24, "24"],
							[36, "36"],
							[48, "48"],
						],
						() => target.screenLines,
						(lines) => setup({ lines }),
					),
					choice(
						"Pages",
						[
							[24, "6 x 24"],
							[25, "5 x 25"],
							[36, "4 x 36"],
							[48, "3 x 48"],
							[72, "2 x 72"],
							[144, "1 x 144"],
						],
						() => target.pageLines,
						(pageLines) => setup({ pageLines }),
					),
					choice(
						"Status line",
						[
							[0, "None"],
							[1, "Indicator"],
							[2, "Host-writable"],
						],
						() => target.statusType,
						(statusDisplay) => setup({ statusDisplay }),
					),
					choice(
						"Cursor",
						[
							["block", "Block"],
							["underline", "Underline"],
						],
						() => display.cursorStyle,
						(cursorStyle) => shown({ cursorStyle }),
					),
					toggle(
						"Cursor blink",
						["Steady", "Blinking"],
						() => display.cursorBlink,
						(cursorBlink) => shown({ cursorBlink }),
					),
					toggle(
						"Scroll",
						["Jump", "Smooth"],
						() => target.smoothScroll,
						(smoothScroll) => setup({ smoothScroll }),
					),
					choice(
						"Smooth speed",
						[
							[RATES[0]!, "Slow"],
							[RATES[1]!, "Moderate"],
							[RATES[2]!, "Fast"],
						],
						() => display.smoothRate,
						(smoothRate) => shown({ smoothRate }),
					),
					toggle(
						"Screen",
						["Dark", "Light"],
						() => target.screenReverse,
						(on) => {
							target.screenReverse = on;
						},
					),
				],
			},
			{
				title: "General",
				items: [
					choice(
						"Mode",
						[
							["vt400-7", "VT400, 7-bit"],
							["vt400-8", "VT400, 8-bit"],
							["vt100", "VT100"],
						],
						() => (target.level === 1 ? "vt100" : target.eightBitControls ? "vt400-8" : "vt400-7"),
						(mode) => setup({ level: mode === "vt100" ? 1 : 4, eightBitControls: mode === "vt400-8" }),
					),
					choice(
						"Identify as",
						[
							["vt420", "VT420"],
							["vt320", "VT320"],
							["vt220", "VT220"],
							["vt100", "VT100"],
						],
						() => target.setup.alias,
						(alias) => setup({ alias }),
					),
					choice(
						"Supplemental",
						[
							["dec", "DEC Supplemental"],
							["latin1", "ISO Latin-1"],
						],
						() => target.userPreferred,
						(userPreferred) => setup({ userPreferred }),
					),
					toggle(
						"Character sets",
						["Multinational", "National"],
						() => target.national,
						// the national sets are the worldwide model's
						(national) => setup(national ? { worldwide: true, national } : { national }),
					),
					choice(
						"National set",
						NATIONAL,
						() => target.setup.nationalSet,
						(nationalSet) => setup({ nationalSet }),
					),
					toggle(
						"User keys",
						["Unlocked", "Locked"],
						() => target.udkLocked,
						(udkLocked) => setup({ udkLocked }),
					),
				],
			},
		];
		this.right = [
			{
				title: "Keyboard",
				items: [
					toggle(
						"Auto wrap",
						["Off", "On"],
						() => target.autowrap,
						(autowrap) => setup({ autowrap }),
					),
					toggle(
						"New line",
						["Off", "On"],
						() => target.newLine,
						(newLine) => setup({ newLine }),
					),
					toggle(
						"<X key",
						["Delete", "Backspace"],
						() => target.backarrowBS,
						(backarrowBS) => setup({ backarrowBS }),
					),
					toggle(
						"Keypad",
						["Numeric", "Application"],
						() => target.keypadApplication,
						(keypadApplication) => setup({ keypadApplication }),
					),
					toggle(
						"Cursor keys",
						["Normal", "Application"],
						() => target.cursorKeysApplication,
						(cursorKeysApplication) => setup({ cursorKeysApplication }),
					),
					toggle(
						"Alt key",
						["None", "Meta (ESC)"],
						() => display.altMeta,
						(altMeta) => shown({ altMeta }),
					),
					toggle(
						"Keyclick",
						["Off", "On"],
						() => display.keyclick,
						(keyclick) => shown({ keyclick }),
					),
					toggle(
						"Bell",
						["Off", "On"],
						() => display.bell,
						(bell) => shown({ bell }),
					),
				],
			},
			{
				title: "Communications",
				items: [
					toggle(
						"Local echo",
						["Off", "On"],
						() => target.localEcho,
						(localEcho) => setup({ localEcho }),
					),
					choice(
						"Line speed",
						SPEEDS.map((speed) => [speed, speed === 0 ? "Unlimited" : String(speed)] as [number, string]),
						() => display.baud,
						(baud) => shown({ baud }),
					),
					toggle(
						"Transmit",
						["Unlimited", "Limited"],
						() => target.transmitLimited,
						(transmitLimited) => setup({ transmitLimited }),
					),
				],
			},
			{
				title: "Look",
				items: [
					choice(
						"Phosphor",
						[
							["white", "White"],
							["green", "Green"],
							["amber", "Amber"],
						],
						() => display.phosphor,
						(phosphor) => shown({ phosphor }),
					),
					choice(
						"Weight",
						[
							["thin", "Thin"],
							["medium", "Medium"],
							["heavy", "Heavy"],
						],
						() => display.weight,
						(weight) => shown({ weight }),
					),
					choice(
						"Persistence",
						[
							["off", "Off"],
							["short", "Short"],
							["medium", "Medium"],
							["long", "Long"],
						],
						() => display.persistence,
						(persistence) => shown({ persistence }),
					),
				],
			},
		];
		this.actions = [
			{ label: "Save", run: () => this.done(host.save, "Saved") },
			{ label: "Recall", run: () => this.done(() => host.recall(false), "Recalled") },
			{ label: "Default", run: () => this.done(() => host.recall(true), "Factory settings") },
			{ label: "Clear Display", run: () => this.done(() => target.feed("\x1b[H\x1b[2J"), "Cleared") },
			{ label: "Reset Terminal", run: () => this.done(() => target.softReset(), "Reset") },
			{ label: "Exit", run: () => host.exit() },
		];
		this.draw();
	}

	private get items(): Item[] {
		return [...this.left, ...this.right].flatMap((section) => section.items);
	}

	private get count(): number {
		return this.items.length + this.actions.length;
	}

	private done(run: () => void, message: string): void {
		run();
		this.message = message;
	}

	key(press: KeyPress): void {
		const items = this.items;
		this.message = "";
		switch (press.key) {
			case "Up":
				this.selected = (this.selected + this.count - 1) % this.count;
				break;
			case "Down":
			case "Tab":
				this.selected = (this.selected + 1) % this.count;
				break;
			case "Left":
			case "Right":
			case "Return":
			case "KPEnter":
			case "Do":
			case " ": {
				const item = items[this.selected];
				if (!item) {
					if (press.key !== "Left" && press.key !== "Right") this.actions[this.selected - items.length]?.run();
					else
						this.selected =
							items.length +
							((this.selected - items.length + (press.key === "Left" ? -1 : 1) + this.actions.length) %
								this.actions.length);
					break;
				}
				const step = press.key === "Left" ? -1 : 1;
				item.set((item.get() + step + item.values.length) % item.values.length);
				break;
			}
			case "Escape":
				this.host.exit();
				return;
		}
		this.draw();
	}

	/** The whole screen again, as a VT420 program would draw it. */
	draw(): void {
		const items = this.items;
		const width = 39;
		let out = "\x1b[?25l\x1b[m\x1b[H\x1b[2J";
		out += "\x1b[1;1H\x1b#3      VT420 Set-Up\x1b[2;1H\x1b#4      VT420 Set-Up";
		out += `\x1b[3;1H\x1b(0${"q".repeat(80)}\x1b(B`;
		let index = 0;
		const column = (sections: Array<{ title: string; items: Item[] }>, left: number): void => {
			let row = 4;
			for (const section of sections) {
				out += `\x1b[${row};${left + 2}H\x1b[1;4m${section.title}\x1b[m`;
				row++;
				for (const item of section.items) {
					const value = item.values[item.get()] ?? "";
					const selected = index === this.selected;
					out += `\x1b[${row};${left + 3}H${item.label.padEnd(16)}`;
					out += selected ? `\x1b[7m ${value} \x1b[m` : ` ${value} `;
					row++;
					index++;
				}
			}
		};
		column(this.left, 0);
		column(this.right, width + 1);
		out += `\x1b[22;1H\x1b(0${"q".repeat(80)}\x1b(B\x1b[23;3H`;
		this.actions.forEach((action, i) => {
			const selected = items.length + i === this.selected;
			out += selected ? `\x1b[7m ${action.label} \x1b[m  ` : ` ${action.label}   `;
		});
		const hint = this.message || "Arrows move and change, Enter acts, Esc leaves";
		out += `\x1b[24;3H\x1b[1m${hint}\x1b[m`;
		this.term.feed(out);
	}
}
