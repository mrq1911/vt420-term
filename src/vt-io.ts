/**
 * Talking to the VT420 a program runs on, for vt420-demo and vt420-animations: keys apart from answers, and output
 * paced by the terminal's answers, so that it never has more coming than its input buffer holds, whatever the line
 * and whether flow control gets back in time. The modes a show changes are put back when it ends.
 */

export interface Answer {
	text: string;
	at: number;
}

/** Split bytes into pieces no control sequence or string is cut across. */
export function atoms(bytes: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < bytes.length) {
		const start = i;
		if (bytes[i] !== "\x1b") {
			i++;
			// plain text runs together
			while (i < bytes.length && bytes[i] !== "\x1b") i++;
			out.push(bytes.slice(start, i));
			continue;
		}
		i++;
		const next = bytes[i];
		if (next === "[") {
			i++;
			while (i < bytes.length && !(bytes.charCodeAt(i) >= 0x40 && bytes.charCodeAt(i) <= 0x7e)) i++;
			i++;
		} else if (next === "N" || next === "O") {
			// a single shift belongs with the character it shifts
			i += 2;
		} else if (next === "P" || next === "]" || next === "^" || next === "_" || next === "X") {
			// a string, to ST
			while (i < bytes.length && !(bytes[i] === "\x1b" && bytes[i + 1] === "\\")) i++;
			i += 2;
		} else {
			while (i < bytes.length && bytes.charCodeAt(i) >= 0x20 && bytes.charCodeAt(i) <= 0x2f) i++;
			i++;
		}
		out.push(bytes.slice(start, Math.min(i, bytes.length)));
	}
	return out;
}

/** Pieces of at most `size` bytes, longer text split anywhere but inside a sequence. */
export function pieces(bytes: string, size: number): string[] {
	const out: string[] = [];
	let current = "";
	for (const atom of atoms(bytes)) {
		const parts = atom.startsWith("\x1b") ? [atom] : (atom.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? []);
		for (const part of parts) {
			if (current.length + part.length > size && current !== "") {
				out.push(current);
				current = "";
			}
			current += part;
		}
	}
	if (current !== "") out.push(current);
	return out;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Bytes in a piece before the terminal is asked to answer; two pieces at most are out at once. */
const PIECE = 96;

export class Tty {
	private readonly input: number[] = [];
	private readonly answers: Answer[] = [];
	private waiting: (() => void) | undefined;
	private keyHandler: ((key: string) => void) | undefined;
	private readonly out: NodeJS.WriteStream;
	private answered = true;
	/** Pieces sent and not answered yet. */
	private outstanding = 0;

	constructor() {
		this.out = process.stdout;
		if (process.stdin.isTTY) process.stdin.setRawMode(true);
		process.stdin.on("data", (chunk: Buffer) => {
			for (const byte of chunk) this.input.push(byte);
			this.sort();
		});
	}

	onKey(handler: (key: string) => void): void {
		this.keyHandler = handler;
	}

	/** Out at once, with no pacing: for a few bytes. */
	write(bytes: string): void {
		this.out.write(Buffer.from(bytes, "latin1"));
	}

	/** Out in pieces, each answered before more than one other is out; at once to a terminal that never answers. */
	async send(bytes: string): Promise<void> {
		if (!this.answered) {
			this.write(bytes);
			return;
		}
		for (const piece of pieces(bytes, PIECE)) {
			while (this.outstanding >= 2) await this.answer(1500, /^\x1b\[0n$/);
			this.outstanding++;
			this.write(`${piece}\x1b[5n`);
		}
	}

	/** Everything sent so far answered. */
	async drain(): Promise<void> {
		while (this.outstanding > 0 && this.answered) {
			const found = await this.answer(1500, /^\x1b\[0n$/);
			if (!found) this.outstanding = 0;
		}
	}

	/** Ask, and the answer; undefined when none comes in time. */
	async ask(query: string, timeoutMs = 1500): Promise<string | undefined> {
		await this.drain();
		this.write(query);
		return (await this.answer(timeoutMs))?.text;
	}

	/** The next answer, one matching `pattern` if given; others are dropped meanwhile. */
	private async answer(timeoutMs: number, pattern?: RegExp): Promise<Answer | undefined> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const index = this.answers.findIndex((answer) => !pattern || pattern.test(answer.text));
			if (index >= 0) {
				const [found] = this.answers.splice(0, index + 1).slice(-1);
				if (pattern?.test(found!.text)) this.outstanding = Math.max(0, this.outstanding - 1);
				return found;
			}
			const left = deadline - Date.now();
			if (left <= 0) {
				// no answer: an emulator that keeps quiet, or a line that lost it; on with the show
				if (pattern) this.outstanding = Math.max(0, this.outstanding - 1);
				this.answered = false;
				return undefined;
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, Math.min(left, 100));
				this.waiting = () => {
					clearTimeout(timer);
					resolve();
				};
			});
		}
	}

	/** Answers (CSI ... n, R, y, c and DCS strings) apart from keys. */
	private sort(): void {
		for (;;) {
			const bytes = this.input;
			if (bytes.length === 0) break;
			if (bytes[0] === 0x11 || bytes[0] === 0x13) {
				bytes.shift();
				continue;
			}
			if (bytes[0] === 0x1b && bytes[1] === 0x5b) {
				let end = 2;
				while (end < bytes.length && !(bytes[end]! >= 0x40 && bytes[end]! <= 0x7e)) end++;
				if (end >= bytes.length) break;
				const text = String.fromCharCode(...bytes.splice(0, end + 1));
				if (/[nRyc]$/.test(text) && !/^\x1b\[\d*~$/.test(text)) this.answers.push({ text, at: Date.now() });
				else this.keyHandler?.(text);
				continue;
			}
			if (bytes[0] === 0x1b && bytes[1] === 0x50) {
				let end = 2;
				while (end + 1 < bytes.length && !(bytes[end] === 0x1b && bytes[end + 1] === 0x5c)) end++;
				if (end + 1 >= bytes.length) break;
				this.answers.push({ text: String.fromCharCode(...bytes.splice(0, end + 2)), at: Date.now() });
				continue;
			}
			if (bytes[0] === 0x1b && bytes.length === 1) {
				// a lone ESC may be the start of an answer still on its way
				setTimeout(() => {
					if (this.input.length === 1 && this.input[0] === 0x1b) {
						this.input.shift();
						this.keyHandler?.("\x1b");
					}
				}, 50);
				break;
			}
			this.keyHandler?.(String.fromCharCode(bytes.shift()!));
		}
		this.waiting?.();
	}

	/** Whether the terminal answers at all. */
	get answering(): boolean {
		return this.answered;
	}

	close(): void {
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		process.stdin.pause();
	}
}

/** The modes and settings a show changes, as the terminal had them, and the bytes that put them back. */
export async function snapshot(tty: Tty): Promise<string> {
	let back = "\x1b[!p\x1b[?69l\x1b[r\x1b[m\x1b[1 P";
	for (const mode of [1, 4, 5, 7, 25, 66]) {
		const answer = await tty.ask(`\x1b[?${mode}$p`, 800);
		const value = /;([12])\$y$/.exec(answer ?? "")?.[1];
		if (value) back += `\x1b[?${mode}${value === "1" ? "h" : "l"}`;
	}
	for (const setting of ["$|", "*|", "t", "$~"]) {
		const answer = await tty.ask(`\x1bP$q${setting}\x1b\\`, 800);
		// a valid report has the setting in it, whichever of 0 and 1 the terminal takes for valid
		const value = /^\x1bP[01]\$r(.+?)\x1b\\$/.exec(answer ?? "")?.[1];
		if (value) back += `\x1b[${value}`;
	}
	return `${back}\x1b[H\x1b[2J`;
}
