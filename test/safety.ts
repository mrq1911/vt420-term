/**
 * What a VT420 may receive: the controls, escape sequences and control strings the VT420 frontend sends, with the
 * parameters it uses. Anything else in a byte stream is a violation, so a test can prove that no output of a
 * program running inside the adapter ever reaches the terminal unchanged.
 */

export interface SafetyOptions {
	/** The terminal decodes UTF-8 (an emulator): bytes from 0x80 are text. */
	unicode?: boolean;
	/** Supplemental glyphs may go out as 8-bit GR codes. */
	eightBit?: boolean;
}

const C0_ALLOWED = new Set([0x07, 0x08, 0x0a, 0x0d, 0x0e, 0x0f]);
const ESC_ALLOWED = new Set(["D", "M", "7", "8", "=", ">", "n", "o", "|", "}", "~", "N", "O", "\\"]);
const SCS_ALLOWED = new Set(["(B", ")0", ")B", "*>", "*B", "*%5", "+%5", "+B", "/A", " F", "#3", "#4", "#5", "#6"]);
const SGR_ALLOWED = new Set([0, 1, 4, 5, 7, 22, 24, 25, 27]);
const ANSI_MODES = new Set([4, 12, 20]);
const DEC_MODES = new Set([1, 5, 6, 7, 25, 66, 69]);

function csiViolation(sequence: string): string | undefined {
	const final = sequence.at(-1)!;
	const body = sequence.slice(0, -1);
	const match = /^([?>=<]?)([0-9;]*)([ -/]*)$/.exec(body);
	if (!match) return `malformed CSI ${JSON.stringify(sequence)}`;
	const [, prefix = "", paramText = "", intermediates = ""] = match;
	const params = paramText === "" ? [] : paramText.split(";").map((part) => (part === "" ? 0 : Number(part)));
	const key = `${prefix}${intermediates}${final}`;
	switch (key) {
		case "H":
		case "A":
		case "B":
		case "C":
		case "D":
		case "K":
		case "J":
		case "X":
		case "P":
		case "r":
		case "s":
		case "c":
		case ">c":
		case "n":
		case "&u":
		case '"v':
		case "?$p":
		case "$p":
		case "$x":
		case "$t":
		case "*x":
		case "$~":
		case "$}":
		case "$|":
		case "*|":
			return undefined;
		case "m":
			for (const param of params) if (!SGR_ALLOWED.has(param)) return `SGR ${param} in ${JSON.stringify(sequence)}`;
			return undefined;
		case "h":
		case "l":
			for (const param of params) if (!ANSI_MODES.has(param)) return `mode ${param}`;
			return undefined;
		case "?h":
		case "?l":
			for (const param of params) if (!DEC_MODES.has(param)) return `private mode ?${param}`;
			return undefined;
		default:
			return `CSI ${JSON.stringify(sequence)}`;
	}
}

/** The start-up probe prints é as two UTF-8 bytes on purpose, to see whether the cursor moves one column or two. */
const UTF8_PROBE = Buffer.from("\x1b7\x1b[2H\xc3\xa9\x1b[6n\x1b8", "latin1");

/** Every byte or sequence in `bytes` a VT420 should not receive. */
export function vt420Violations(bytes: Uint8Array, options: SafetyOptions = {}): string[] {
	const violations: string[] = [];
	const at = (index: number, what: string): void => {
		if (violations.length < 50) violations.push(`${index}: ${what}`);
	};
	let index = 0;
	while (index < bytes.length) {
		if (bytes[index] === 0x1b && Buffer.from(bytes.subarray(index, index + UTF8_PROBE.length)).equals(UTF8_PROBE)) {
			index += UTF8_PROBE.length;
			continue;
		}
		const byte = bytes[index]!;
		if (byte === 0x1b) {
			const next = bytes[index + 1];
			if (next === undefined) {
				at(index, "ESC at the end");
				break;
			}
			const char = String.fromCharCode(next);
			if (char === "[") {
				let end = index + 2;
				while (end < bytes.length && (bytes[end]! < 0x40 || bytes[end]! > 0x7e)) end++;
				const sequence = Buffer.from(bytes.subarray(index + 2, end + 1)).toString("latin1");
				const violation = csiViolation(sequence);
				if (violation) at(index, violation);
				index = end + 1;
				continue;
			}
			if (char === "P") {
				const end = Buffer.from(bytes).indexOf("\x1b\\", index + 2, "latin1");
				const data = Buffer.from(bytes.subarray(index + 2, end < 0 ? bytes.length : end)).toString("latin1");
				if (!data.startsWith("$q")) at(index, `DCS ${JSON.stringify(data.slice(0, 20))}`);
				index = end < 0 ? bytes.length : end + 2;
				continue;
			}
			if (char === "]" || char === "_" || char === "^" || char === "X") {
				at(index, `control string ESC ${char}`);
				index += 2;
				continue;
			}
			const two = String.fromCharCode(next, bytes[index + 2] ?? 0);
			const three = two + String.fromCharCode(bytes[index + 3] ?? 0);
			if (SCS_ALLOWED.has(three)) index += 4;
			else if (SCS_ALLOWED.has(two)) index += 3;
			else if (ESC_ALLOWED.has(char)) index += 2;
			else {
				at(index, `ESC ${JSON.stringify(char)}`);
				index += 2;
			}
			continue;
		}
		if (byte < 0x20 && !C0_ALLOWED.has(byte)) at(index, `C0 0x${byte.toString(16)}`);
		else if (byte === 0x7f) at(index, "DEL");
		else if (byte >= 0x80 && !options.unicode && !(options.eightBit && byte >= 0xa0)) {
			at(index, `8-bit 0x${byte.toString(16)}`);
		}
		index++;
	}
	return violations;
}
