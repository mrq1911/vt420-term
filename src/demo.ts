/**
 * vt420-demo: a tour of what a VT420 can do, scene by scene, drawn with its own control functions: double-size
 * lines, attributes, line drawing and DEC Technical, rectangles, smooth scroll inside margins, side-by-side windows,
 * a soft font, page memory, 132 columns and 48 lines, and the status line telling where it is all along.
 *
 * Keys: n the next scene, space to pause, q to stop. It puts the terminal back as it was when it ends.
 */

import { sleep, snapshot, Tty } from "./vt-io.ts";
import { TECHNICAL } from "./vt420/charset.ts";

const CSI = "\x1b[";
const at = (row: number, col: number): string => `${CSI}${row};${col}H`;
const sgr = (...values: number[]): string => `${CSI}${values.join(";")}m`;
const CLEAR = `${CSI}m${CSI}H${CSI}2J`;
/**
 * G1 is DEC Special Graphics, shifted in with SO; G2 DEC Technical, for one character after SS2, unless a scene
 * puts the soft font there; G3 DEC Supplemental, in GR for 8-bit characters.
 */
const SETS = "\x1b(B\x1b)0\x1b*>\x1b+%5\x1b|";
const TECHNICAL_IN_G2 = "\x1b*>";
const SOFT_IN_G2 = "\x1b* @";
const GRAPHICS = (text: string): string => `\x0e${text}\x0f`;
const TECH_CODES = new Map([...TECHNICAL].map(([code, char]) => [char, String.fromCharCode(code)]));
/** Text with DEC Technical characters where it has them. */
const tech = (text: string): string =>
	[...text].map((char) => (TECH_CODES.has(char) ? `\x1bN${TECH_CODES.get(char)}` : char)).join("");
const centred = (text: string, width = 80): number => Math.max(1, Math.floor((width - text.length) / 2) + 1);

class Skip extends Error {}
class Stop extends Error {}

interface Scene {
	name: string;
	run(show: Show): Promise<void>;
}

class Show {
	readonly tty: Tty;
	index = 0;
	count = 0;
	private skip = false;
	private stop = false;
	private paused = false;

	constructor(tty: Tty) {
		this.tty = tty;
		tty.onKey((key) => {
			if (key === "q" || key === "Q" || key === "\x03") this.stop = true;
			else if (key === "n" || key === "N" || key === "\r") this.skip = true;
			else if (key === " ") this.paused = !this.paused;
		});
	}

	get stopped(): boolean {
		return this.stop;
	}

	private check(): void {
		if (this.stop) throw new Stop();
		if (this.skip) {
			this.skip = false;
			throw new Skip();
		}
	}

	async draw(bytes: string): Promise<void> {
		this.check();
		await this.tty.send(bytes);
	}

	/** Draw, wait until the terminal has, then hold it for `ms`. */
	async frame(bytes: string, ms: number): Promise<void> {
		await this.draw(bytes);
		await this.tty.drain();
		await this.hold(ms);
	}

	async hold(ms: number): Promise<void> {
		const end = Date.now() + ms;
		while (Date.now() < end || this.paused) {
			this.check();
			await sleep(Math.min(50, Math.max(1, end - Date.now())));
		}
	}

	/** The scene's caption on the host-writable status line. */
	status(text: string): string {
		const keys = "n next  q quit ";
		const line = ` vt420-demo  ${this.index + 1}/${this.count}  ${text}`.slice(0, 79 - keys.length);
		return `${CSI}1$}\r${CSI}2K${sgr(0)}${line}${at(1, 81 - keys.length)}${keys}${CSI}0$}`;
	}

	/** A scene's title in double-height letters on the top two rows. */
	title(text: string): string {
		const col = centred(text, 40);
		return `${at(1, 1)}\x1b#3${at(1, col)}${sgr(1)}${text}${at(2, 1)}\x1b#4${at(2, col)}${text}${sgr(0)}`;
	}

	/** A title for a scene with left and right margins, under which a VT420 keeps every line single size. */
	plainTitle(text: string): string {
		const spaced = [...text.toUpperCase()].join(" ");
		return `${at(2, centred(spaced))}${sgr(1)}${spaced}${sgr(0)}`;
	}
}

/** A soft font: 10 by 16 dots a character, in sixels, loaded as the set named " @". */
function softFont(glyphs: string[][]): string {
	const encoded = glyphs.map((rows) => {
		const pixel = (row: number, col: number): number => (rows[row]?.[col] === "#" ? 1 : 0);
		const groups: string[] = [];
		for (let group = 0; group < 3; group++) {
			let sixels = "";
			for (let col = 0; col < 10; col++) {
				let bits = 0;
				for (let bit = 0; bit < 6; bit++) bits |= pixel(group * 6 + bit, col) << bit;
				sixels += String.fromCharCode(0x3f + bits);
			}
			groups.push(sixels);
		}
		return groups.join("/");
	});
	return `\x1bP1;1;1;10;0;2;16;0{ @${encoded.join(";")}\x1b\\`;
}

const pad = (shape: string[]): string[] => [...new Array(4).fill(""), ...shape];

const INVADER_A = pad([
	"..#....#..",
	"...#..#...",
	"..######..",
	".##.##.##.",
	"##########",
	"#.######.#",
	"#.#....#.#",
	"...##.##..",
]);
const INVADER_B = pad([
	"..#....#..",
	"#..#..#..#",
	"#.######.#",
	"###.##.###",
	"##########",
	".########.",
	"..#....#..",
	".#......#.",
]);
const HEART = pad([
	"..........",
	".##...##..",
	"####.####.",
	"#########.",
	"#########.",
	".#######..",
	"..#####...",
	"...###....",
	"....#.....",
]);
const SHIP = pad(["....##....", "....##....", "...####...", ".########.", "##########", "##########", "#.#.##.#.#"]);
/** The soft characters by name: SS2 with the soft font in G2, and the character loaded at 0x21 onwards. */
const SOFT = { invaderA: "\x1bN!", invaderB: '\x1bN"', heart: "\x1bN#", ship: "\x1bN$" };
const FONT = softFont([INVADER_A, INVADER_B, HEART, SHIP]);

const SCENES: Scene[] = [
	{
		name: "the VT420",
		async run(show) {
			await show.frame(`${CLEAR}${show.status("the VT420 video terminal")}`, 200);
			await show.frame(show.title("VT420"), 400);
			const subtitle = "a video terminal from Digital, 1990";
			await show.frame(`${at(4, 1)}\x1b#6${at(4, centred(subtitle, 40))}${subtitle}`, 600);
			const lines = [
				"80 or 132 columns, 24, 36 or 48 lines, six pages of memory",
				"double-width and double-height lines, smooth scroll",
				"DEC line drawing, DEC Technical, multinational characters",
				"rectangles, soft fonts, user-defined keys, a status line",
			];
			for (const [index, line] of lines.entries()) {
				for (let i = 0; i <= line.length; i += 4) {
					await show.frame(`${at(8 + index * 2, centred(line))}${line.slice(0, i)}`, 20);
				}
			}
			await show.frame(`${at(18, 1)}${GRAPHICS(`l${"q".repeat(78)}k`)}${at(19, 1)}${GRAPHICS("x")}`, 0);
			const hint = "n skips a scene, space pauses, q stops";
			await show.frame(
				`${at(19, centred(hint))}${sgr(5)}${hint}${sgr(0)}${at(19, 80)}${GRAPHICS("x")}${at(20, 1)}${GRAPHICS(`m${"q".repeat(78)}j`)}`,
				3500,
			);
		},
	},
	{
		name: "character attributes",
		async run(show) {
			await show.frame(`${CLEAR}${show.status("character attributes")}${show.title("Attributes")}`, 300);
			const rows: Array<[string, number[]]> = [
				["normal", [0]],
				["bold", [1]],
				["underline", [4]],
				["blink", [5]],
				["reverse", [7]],
				["bold underline", [1, 4]],
				["bold reverse blink", [1, 7, 5]],
				["invisible", [8]],
			];
			for (const [index, [name, values]] of rows.entries()) {
				const row = 5 + index * 2;
				await show.frame(
					`${at(row, 6)}${name.padEnd(20)}${sgr(...values)} The VT420 video terminal ${sgr(0)}`,
					250,
				);
			}
			await show.hold(1200);
			// reverse video swept across the rectangle and back, then bold, without writing a character (DECRARA)
			await show.draw(`${CSI}2*x`);
			for (let col = 26; col <= 76; col += 5) {
				await show.frame(`${CSI}5;${col};19;${col + 4};7$t`, 60);
			}
			for (let col = 26; col <= 76; col += 5) {
				await show.frame(`${CSI}5;${col};19;${col + 4};7$t`, 60);
			}
			await show.frame(`${CSI}5;6;19;76;1$t`, 900);
			await show.frame(`${CSI}5;6;19;76;1$t`, 1500);
		},
	},
	{
		name: "line drawing",
		async run(show) {
			await show.frame(`${CLEAR}${show.status("DEC Special Graphics")}${show.title("Line drawing")}`, 300);
			// a window with a table in it
			const box = (top: number, left: number, bottom: number, right: number): string => {
				let out = `${at(top, left)}${GRAPHICS(`l${"q".repeat(right - left - 1)}k`)}`;
				for (let row = top + 1; row < bottom; row++)
					out += `${at(row, left)}${GRAPHICS("x")}${at(row, right)}${GRAPHICS("x")}`;
				return `${out}${at(bottom, left)}${GRAPHICS(`m${"q".repeat(right - left - 1)}j`)}`;
			};
			await show.frame(box(4, 3, 14, 38), 200);
			const table = [
				`${GRAPHICS("x")} Set        ${GRAPHICS("x")} Final ${GRAPHICS("x")} Size ${GRAPHICS("x")}`,
				GRAPHICS(`t${"q".repeat(12)}n${"q".repeat(7)}n${"q".repeat(6)}u`),
				`${GRAPHICS("x")} ASCII      ${GRAPHICS("x")} B     ${GRAPHICS("x")} 94   ${GRAPHICS("x")}`,
				`${GRAPHICS("x")} Graphics   ${GRAPHICS("x")} 0     ${GRAPHICS("x")} 94   ${GRAPHICS("x")}`,
				`${GRAPHICS("x")} Technical  ${GRAPHICS("x")} >     ${GRAPHICS("x")} 94   ${GRAPHICS("x")}`,
				`${GRAPHICS("x")} Latin-1    ${GRAPHICS("x")} A     ${GRAPHICS("x")} 96   ${GRAPHICS("x")}`,
			];
			await show.frame(`${at(5, 6)}${GRAPHICS(`l${"q".repeat(12)}w${"q".repeat(7)}w${"q".repeat(6)}k`)}`, 0);
			for (const [index, row] of table.entries()) await show.frame(`${at(6 + index, 6)}${row}`, 120);
			await show.frame(`${at(12, 6)}${GRAPHICS(`m${"q".repeat(12)}v${"q".repeat(7)}v${"q".repeat(6)}j`)}`, 400);
			// the symbols
			await show.frame(
				`${box(4, 42, 14, 78)}${at(6, 45)}diamond ${GRAPHICS("`")}  checker ${GRAPHICS("aaa")}  degree ${GRAPHICS("f")}${at(8, 45)}plus-minus ${GRAPHICS("g")}  pi ${GRAPHICS("{")}  pound ${GRAPHICS("}")}${at(10, 45)}${GRAPHICS("y")} less or equal  ${GRAPHICS("z")} greater${at(12, 45)}controls ${GRAPHICS("bcde h i")}`,
				400,
			);
			// a wave of scan lines 1, 3, 5, 7 and 9
			const scan = "opqrs";
			for (let t = 0; t < 48; t++) {
				let wave = "";
				for (let col = 0; col < 76; col++) {
					const level = Math.round(2 + 2 * Math.sin((col + t * 2) / 5));
					wave += scan[level];
				}
				await show.frame(`${at(18, 3)}${GRAPHICS(wave)}${at(19, 3)}${GRAPHICS([...wave].reverse().join(""))}`, 40);
			}
			await show.hold(800);
		},
	},
	{
		name: "DEC Technical",
		async run(show) {
			await show.frame(`${CLEAR}${show.status("the DEC Technical character set")}${show.title("Technical")}`, 300);
			// an integral and a case, built from the set's pieces
			await show.frame(
				`${at(6, 8)}${tech("⌠ ∞")}${at(7, 8)}${tech("│   e  dx = √π")}${at(6, 15)}${tech("-x²")}${at(8, 8)}${tech("⌡ 0")}${at(7, 25)}${tech("─")}${at(8, 25)}2`,
				500,
			);
			await show.frame(
				`${at(6, 40)}${tech("        ⎧ 1   if x ≥ 0")}${at(7, 40)}${tech("f(x) = ⎨")}${at(8, 40)}${tech("        ⎩ 0   if x < 0")}`,
				500,
			);
			await show.frame(
				`${at(11, 8)}${tech("⎡ cos θ  -sin θ ⎤")}${at(12, 8)}${tech("⎣ sin θ   cos θ ⎦")}${at(11, 40)}${tech("∇ × E = -∂B/∂t")}${at(12, 40)}${tech("A ⊂ B ⇒ A ∩ B = A")}`,
				500,
			);
			const lines = [
				"αβχδεφγηικλνπψρστυωξζθ",
				"ΓΔΘΛΞΠΣΦΨΩ",
				"∞ ∝ ∂ ∇ ≤ ≥ ≠ ≡ ≃ ∼ ÷ ×",
				"⇒ ⇔ ⊂ ⊃ ∩ ∪ ∧ ∨ ¬ ∴ ← ↑ → ↓",
			];
			for (const [index, line] of lines.entries()) {
				const spaced = [...line].join(line.includes(" ") ? "" : " ");
				for (let i = 1; i <= [...spaced].length; i++) {
					if (spaced[i - 1] === " ") continue;
					await show.frame(`${at(15 + index * 2, 8)}${tech([...spaced].slice(0, i).join(""))}`, 15);
				}
			}
			await show.hold(2500);
		},
	},
	{
		name: "rectangles",
		async run(show) {
			await show.frame(`${CLEAR}${show.status("DECFRA, DECCRA, DECCARA, DECERA")}${show.title("Rectangles")}`, 300);
			await show.draw(`${CSI}2*x`);
			// filled rectangles, one inside the other (DECFRA)
			const fills = [97, 32, 97, 32, 97];
			for (const [index, code] of fills.entries()) {
				const inset = index * 2;
				const rendition = index % 2 === 0 ? sgr(0) : sgr(7);
				await show.frame(
					`${rendition}\x0e${CSI}${code};${4 + inset};${3 + inset * 2};${22 - inset};${40 - inset * 2}$x\x0f${sgr(0)}`,
					150,
				);
			}
			// a stamp copied about (DECCRA)
			await show.frame(
				`${at(5, 46)}${GRAPHICS("lqqqqqk")}${at(6, 46)}${GRAPHICS("x")}VT420${GRAPHICS("x")}${at(7, 46)}${GRAPHICS("mqqqqqj")}`,
				300,
			);
			const spots: Array<[number, number]> = [
				[5, 56],
				[5, 66],
				[9, 46],
				[9, 56],
				[9, 66],
				[13, 46],
				[13, 56],
				[13, 66],
				[17, 46],
				[17, 56],
				[17, 66],
			];
			for (const [row, col] of spots) await show.frame(`${CSI}5;46;7;52;1;${row};${col};1$v`, 90);
			// attributes swept across them (DECCARA)
			for (const values of [[1], [4], [7], [0]]) {
				for (let row = 5; row <= 17; row += 4) {
					await show.frame(`${CSI}${row};46;${row + 2};72;${values.join(";")}$r`, 70);
				}
			}
			await show.hold(600);
			// erased in a spiral (DECERA)
			let [top, left, bottom, right] = [4, 3, 22, 78];
			while (top <= bottom && left <= right) {
				await show.frame(`${CSI}${top};${left};${top};${right}$z`, 25);
				top++;
				await show.frame(`${CSI}${top};${right - 1};${bottom};${right}$z`, 25);
				right -= 2;
				await show.frame(`${CSI}${bottom};${left};${bottom};${right}$z`, 25);
				bottom--;
				await show.frame(`${CSI}${top};${left};${bottom};${left + 1}$z`, 25);
				left += 2;
			}
			await show.hold(500);
		},
	},
	{
		name: "smooth scroll",
		async run(show) {
			await show.frame(`${CLEAR}${show.status("smooth scroll inside margins")}${show.title("Smooth scroll")}`, 300);
			await show.frame(`${at(23, 1)}${GRAPHICS("q".repeat(80))}${at(4, 1)}${GRAPHICS("q".repeat(80))}`, 0);
			const credits = [
				"the screen moves a scan line at a time",
				"",
				"DECSCLM sets it, DECSTBM keeps it",
				"between the top and bottom margins",
				"",
				"the terminal takes nothing in",
				"while a line glides",
				"",
				"a tenth of a second a line",
				"on the VT420 this was measured on",
				"",
				"jump scroll, for comparison:",
			];
			await show.draw(`${CSI}5;22r${CSI}?4h${at(22, 1)}`);
			for (const line of credits) await show.draw(`\r\n${at(22, centred(line))}${line}`);
			await show.tty.drain();
			await show.hold(400);
			await show.draw(`${CSI}?4l`);
			for (let i = 1; i <= 18; i++) await show.draw(`\r\n${at(22, 30)}line ${i} at once`);
			await show.tty.drain();
			await show.frame(`${CSI}?4h`, 300);
			for (const line of ["", "and smoothly again", "", "", ""])
				await show.draw(`\r\n${at(22, centred(line))}${line}`);
			await show.tty.drain();
			await show.frame(`${CSI}?4l${CSI}r`, 1200);
		},
	},
	{
		name: "split screen",
		async run(show) {
			await show.frame(
				`${CLEAR}${show.status("two windows: left and right margins")}${show.plainTitle("Split screen")}`,
				300,
			);
			await show.frame(
				`${at(4, 1)}${GRAPHICS(`l${"q".repeat(38)}k`)}${at(23, 1)}${GRAPHICS(`m${"q".repeat(38)}j`)}${at(4, 41)}${GRAPHICS(`l${"q".repeat(38)}k`)}${at(23, 41)}${GRAPHICS(`m${"q".repeat(38)}j`)}`,
				0,
			);
			let sides = "";
			for (let row = 5; row <= 22; row++)
				sides += `${at(row, 1)}${GRAPHICS("x")}${at(row, 40)}${GRAPHICS("x")}${at(row, 41)}${GRAPHICS("x")}${at(row, 80)}${GRAPHICS("x")}`;
			await show.frame(sides, 200);
			const poem = [
				"Whose woods these are I think",
				"I know. His house is in the",
				"village though; he will not see",
				"me stopping here to watch his",
				"woods fill up with snow.",
				"",
				"My little horse must think it",
				"queer to stop without a",
				"farmhouse near between the",
				"woods and frozen lake the",
				"darkest evening of the year.",
			];
			await show.draw(`${CSI}?69h${CSI}5;22r`);
			let count = 0;
			for (let i = 0; i < 26; i++) {
				const left = poem[i % poem.length]!;
				await show.draw(`${CSI}3;38s${at(22, 3)}\n${at(22, 3)}${left}`);
				for (let twice = 0; twice < 2; twice++) {
					count++;
					const line = `${String(count).padStart(3)}  ${"*".repeat(Math.round(12 + 11 * Math.sin(count / 3)))}`;
					await show.draw(`${CSI}43;78s${at(22, 43)}\n${at(22, 43)}${line}`);
				}
				await show.tty.drain();
				await show.hold(90);
			}
			await show.frame(`${CSI}?69l${CSI}r`, 1000);
		},
	},
	{
		name: "insert and delete",
		async run(show) {
			await show.frame(
				`${CLEAR}${show.status("DECFI, ICH, DCH, DECIC and DECDC")}${show.plainTitle("Editing")}`,
				300,
			);
			// a marquee: the text between the margins moves a column left (DECFI) and the next letter comes in
			const message =
				"     Everything here is drawn by the terminal itself, with the control functions of the VT420 programmer reference...      ";
			await show.draw(
				`${at(5, 9)}${GRAPHICS(`l${"q".repeat(62)}k`)}${at(6, 9)}${GRAPHICS("x")}${at(6, 72)}${GRAPHICS("x")}${at(7, 9)}${GRAPHICS("x")}${at(7, 72)}${GRAPHICS("x")}${at(8, 9)}${GRAPHICS(`m${"q".repeat(62)}j`)}`,
			);
			// margins around the marquee's two rows: DECFI moves what is between them, the box stays
			await show.draw(`${CSI}?69h${CSI}6;7r${CSI}10;71s${at(6, 71)}`);
			for (const char of message) await show.frame(`\x1b9${char}${at(6, 71)}`, 30);
			await show.draw(`${CSI}?69l${CSI}r`);
			// insert characters: a word pushes in from the middle
			const line = "The VT420 terminal.";
			await show.frame(`${at(11, 20)}${line}`, 400);
			for (const char of [..."video "].reverse()) await show.frame(`${at(11, 30)}${CSI}@${char}`, 120);
			await show.hold(600);
			for (let i = 0; i < 6; i++) await show.frame(`${at(11, 30)}${CSI}P`, 120);
			// columns: a block of text breathes as columns go in and come out (DECIC, DECDC)
			let block = "";
			for (let row = 15; row <= 21; row++)
				block += `${at(row, 10)}${"abcdefghijklmnopqrstuvwxyz0123456789".slice(row - 15, row + 20)}`;
			await show.frame(block, 400);
			await show.draw(`${CSI}?69h${CSI}15;21r${CSI}10;70s`);
			for (let i = 0; i < 8; i++) await show.frame(`${at(15, 22)}${CSI}'}`, 80);
			for (let i = 0; i < 8; i++) await show.frame(`${at(15, 22)}${CSI}'~`, 80);
			await show.frame(`${CSI}?69l${CSI}r`, 1200);
		},
	},
	{
		name: "soft font",
		async run(show) {
			await show.frame(`${CLEAR}${show.status("a soft font, loaded with DECDLD")}${show.title("Soft font")}`, 300);
			await show.draw(SOFT_IN_G2);
			await show.frame(`${at(22, 20)}four characters, ten by sixteen dots each, sent as sixels`, 300);
			// a fleet marching, its frames changing as it goes
			for (let step = 0; step < 36; step++) {
				const frame = step % 2 === 0 ? SOFT.invaderA : SOFT.invaderB;
				const offset = step < 18 ? step : 36 - step;
				// double height, as a VT420 draws soft characters too
				let rows = "";
				for (let row = 0; row < 3; row++) {
					for (const [half, line] of [
						["\x1b#3", 5 + row * 3],
						["\x1b#4", 6 + row * 3],
					] as const) {
						rows += `${at(line, 1)}${half}${CSI}2K${at(line, 3 + Math.floor(offset / 2))}${`${frame} `.repeat(8)}`;
					}
				}
				const ship = `${at(18, 1)}${CSI}2K${at(18, 8 + ((step * 2) % 60))}${SOFT.ship}`;
				await show.frame(rows + ship, 120);
			}
			await show.frame(
				`${at(18, 1)}${CSI}2K${at(18, 30)}${sgr(5)}${SOFT.heart} ${SOFT.heart} ${SOFT.heart}${sgr(0)}`,
				2500,
			);
			await show.draw(TECHNICAL_IN_G2);
		},
	},
	{
		name: "page memory",
		async run(show) {
			await show.frame(`${CLEAR}${show.status("six pages, drawn out of sight")}${show.title("Pages")}`, 300);
			await show.frame(
				`${at(12, centred("drawing pages 2 to 6 out of sight..."))}drawing pages 2 to 6 out of sight...`,
				300,
			);
			// with the display not following the cursor (DECPCCM off), draw on the other pages
			await show.draw(`${CSI}?64l`);
			const hands = ["|", "/", "-", "\\", "|"];
			for (let page = 2; page <= 6; page++) {
				const hand = hands[page - 2]!;
				let art = `${CSI}${page} P${CLEAR}`;
				art += `${at(1, 1)}\x1b#3${at(1, 12)}Page ${page}${at(2, 1)}\x1b#4${at(2, 12)}Page ${page}`;
				for (let r = -5; r <= 5; r++) {
					const col = hand === "|" ? 0 : hand === "-" ? r * 2 : hand === "/" ? -r * 2 : r * 2;
					const row = hand === "-" ? 0 : r;
					art += `${at(13 + row, 40 + col)}${sgr(1)}${"#"}${sgr(0)}`;
				}
				art += `${at(21, centred(`this is page ${page} of page memory`))}this is page ${page} of page memory`;
				await show.draw(art);
			}
			await show.draw(`${CSI}1 P${CSI}?64h`);
			await show.tty.drain();
			await show.frame(
				`${at(12, 1)}${CSI}2K${at(12, centred("and now shown, a page at a time (PPA):"))}and now shown, a page at a time (PPA):`,
				800,
			);
			for (let round = 0; round < 3; round++) {
				for (const page of [2, 3, 4, 5, 6]) await show.frame(`${CSI}${page} P`, 150);
			}
			await show.frame(`${CSI}1 P`, 1200);
			// put the other pages back to blank
			await show.draw(`${CSI}?64l`);
			for (let page = 2; page <= 6; page++) await show.draw(`${CSI}${page} P${CLEAR}`);
			await show.draw(`${CSI}1 P${CSI}?64h`);
		},
	},
	{
		name: "132 columns",
		async run(show) {
			await show.frame(`${CLEAR}${show.status("132 columns and 48 lines")}`, 100);
			await show.frame(`${CSI}132$|${CLEAR}`, 300);
			let ruler = "";
			for (let col = 1; col <= 132; col++)
				ruler += col % 10 === 0 ? String((col / 10) % 10) : col % 5 === 0 ? "+" : ".";
			await show.frame(
				`${at(3, 1)}${ruler}${at(5, centred("132 columns: room for a wide listing", 132))}132 columns: room for a wide listing`,
				200,
			);
			for (let row = 8; row <= 20; row++) {
				const text = `${String(row - 7).padStart(4)}  ${"The quick brown fox jumps over the lazy dog. ".repeat(3).slice(0, 120)}`;
				await show.frame(`${at(row, 1)}${text}`, 40);
			}
			await show.hold(2500);
			await show.frame(`${CSI}80$|${CLEAR}`, 300);
			// 48 lines need pages of 48 lines too, or the lower half stays blank
			await show.frame(`${CSI}48t${CSI}48*|${CLEAR}`, 300);
			for (let row = 1; row <= 48; row++) {
				await show.draw(
					`${at(row, 1)}line ${String(row).padStart(2)} of 48${row === 24 ? "   48 lines: a small font, and pages to match" : ""}`,
				);
			}
			await show.tty.drain();
			await show.hold(2500);
			await show.frame(`${CSI}24*|${CSI}24t${CLEAR}`, 300);
		},
	},
	{
		name: "screen",
		async run(show) {
			await show.frame(`${CLEAR}${show.status("alignment, reverse screen, erasing")}${show.title("Screen")}`, 300);
			// DECALN fills the screen with E for adjusting the tube
			await show.frame("\x1b#8", 900);
			for (let i = 0; i < 4; i++) {
				await show.frame(`${CSI}?5h`, 150);
				await show.frame(`${CSI}?5l`, 150);
			}
			// erased from the middle out, as rectangles
			for (let size = 0; size <= 40; size += 2) {
				const top = Math.max(1, 12 - Math.floor(size / 3));
				const bottom = Math.min(24, 13 + Math.floor(size / 3));
				await show.frame(`${CSI}${top};${Math.max(1, 40 - size)};${bottom};${Math.min(80, 41 + size)}$z`, 30);
			}
			await show.frame(
				`${CLEAR}${at(12, centred("selective erase leaves the protected (DECSCA, DECSERA):"))}selective erase leaves the protected (DECSCA, DECSERA):`,
				600,
			);
			let mixed = "";
			for (let row = 14; row <= 18; row++) {
				mixed += at(row, 10);
				for (let i = 0; i < 6; i++) mixed += i % 2 === 0 ? `${CSI}1"q${sgr(1)}KEEP${sgr(0)}${CSI}0"q ` : "gone ";
			}
			await show.frame(mixed, 900);
			await show.frame(`${CSI}14;1;18;80\${`, 1800);
		},
	},
	{
		name: "the end",
		async run(show) {
			await show.frame(`${CLEAR}${show.status("the end")}`, 200);
			await show.frame(show.title("That was a VT420"), 600);
			const lines = ["vt420-demo, from vt420-term", "", "pi-vt420 and zellij-vt420 draw with all of this"];
			for (const [index, line] of lines.entries())
				await show.frame(`${at(8 + index * 2, centred(line))}${line}`, 300);
			await show.draw(SOFT_IN_G2);
			for (let i = 0; i < 6; i++) await show.frame(`${at(16, 35 + i * 2)}${SOFT.heart}`, 120);
			await show.draw(TECHNICAL_IN_G2);
			await show.hold(3000);
		},
	},
];

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("-h") || args.includes("--help")) {
		process.stdout.write(
			`vt420-demo: a tour of the VT420's features, on the VT420 it runs on

Usage: vt420-demo [--loop] [--scene <n>] [--list]

  --loop       start again after the last scene, until q
  --scene <n>  start at scene n
  --list       the scenes

Keys: n the next scene, space to pause, q to stop.
`,
		);
		return;
	}
	if (args.includes("--list")) {
		for (const [index, scene] of SCENES.entries()) process.stdout.write(`${index + 1}  ${scene.name}\n`);
		return;
	}
	const tty = new Tty();
	const show = new Show(tty);
	show.count = SCENES.length;
	const sceneArg = args.indexOf("--scene");
	let index = sceneArg >= 0 ? Math.max(0, Math.min(SCENES.length - 1, Number(args[sceneArg + 1]) - 1 || 0)) : 0;
	const loop = args.includes("--loop");
	const back = await snapshot(tty);
	await tty.send(`${SETS}${FONT}${CSI}2$~${CSI}?25l${CSI}?7l${CSI}r${CLEAR}`);
	try {
		for (;;) {
			show.index = index;
			try {
				await SCENES[index]!.run(show);
			} catch (error) {
				if (error instanceof Stop) break;
				if (!(error instanceof Skip)) throw error;
				// a scene cut short leaves its margins and modes behind
				await tty.send(`${CSI}?69l${CSI}r${CSI}?4l${CSI}?5l${CSI}?64h${CSI}1 P${CSI}m`);
			}
			index++;
			if (index >= SCENES.length) {
				if (!loop || show.stopped) break;
				index = 0;
			}
		}
	} finally {
		// the snapshot has the shape back where the terminal reported it; each new shape keeps a VT420 busy a while
		const shape = back.includes("$|") ? "" : `${CSI}24*|${CSI}24t${CSI}80$|`;
		await tty.send(`${shape}${back}${CSI}1$}\r${CSI}2K${CSI}0$}${CSI}?25h`);
		await tty.drain();
		tty.close();
	}
	process.exit(0);
}

await main();
