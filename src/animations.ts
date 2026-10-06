/**
 * vt420-animations: the classic VT100 animations of textfiles.com's archive (artscene.textfiles.com/vt100), played
 * on the VT420 at the line speed they were made for. They are fetched into a cache the first time; none of them
 * comes with vt420-term.
 *
 * Keys: n or space the next one, p the one before, + and - a faster or slower line, q to stop.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pieces, sleep, snapshot, Tty } from "./vt-io.ts";

const SOURCE = "http://artscene.textfiles.com/vt100/";
const CSI = "\x1b[";
const SPEEDS = [1200, 2400, 4800, 9600, 19200, 38400];

interface Animation {
	file: string;
	title: string;
}

/** The playlist, in an order that shows them off: a test card first, a good night last. */
const PLAYLIST: Animation[] = [
	{ file: "torturet.vt", title: "The VT-100 Torture Test, by Joe Smith (1985)" },
	{ file: "hello.vt", title: "HELLO!" },
	{ file: "globe.vt", title: "Spinning Globe" },
	{ file: "twilight.vt", title: "The Twilight Zone" },
	{ file: "trek.vt", title: "The Enterprise Blows up an RCA Satellite" },
	{ file: "prey.vt", title: "Klingon Bird of Prey" },
	{ file: "sship.vt", title: "Space Ship Warps and Fires" },
	{ file: "nasa.vt", title: "NASA: Keep Reaching for the Stars, by A.J.L." },
	{ file: "firework.vt", title: "Fireworks, by Chen Lin" },
	{ file: "fireworks.vt", title: "Setting Off Fireworks" },
	{ file: "surf.vt", title: "Surfing Wave (in 3-D)" },
	{ file: "pac3d.vt", title: "Pac-Man in 3-D Chomping a Ghost" },
	{ file: "tetris.vt", title: "Tetris" },
	{ file: "bambi.vt", title: "Bambi vs. Godzilla" },
	{ file: "bugsbunny.vt", title: "Bugs Bunny: That's All, Folks" },
	{ file: "strike.vt", title: "Bowling a Strike" },
	{ file: "cartwhee.vt", title: "Doing a Cartwheel" },
	{ file: "frogs.vt", title: "Hopping Frog" },
	{ file: "fishy.vt", title: "Fish Swimming By, Glug Glug" },
	{ file: "fishy-fishy.vt", title: "3-D Fishy Fishy" },
	{ file: "wineglas.vt", title: "Wine Glass Filling" },
	{ file: "glass.vt", title: "Filling Glass of Liquid" },
	{ file: "jumble.vt", title: "Now Is the Time for All Good Men" },
	{ file: "juanspla.vt", title: "A Plan File in the Form of a Typewriter" },
	{ file: "newbeer.vt", title: "Working on a VT100" },
	{ file: "demo.vt", title: "Alan's Impressive Demonstration" },
	{ file: "cursor.vt", title: "Cursor Control Examples in VT100" },
	{ file: "spinweb.vt", title: "Spinning Web, by R.L. Samuell (1994)" },
	{ file: "nifty.vt", title: "NIFTY" },
	{ file: "sun.vt", title: "A Happy Sun" },
	{ file: "blinkeyes.vt", title: "Blinking Eyes" },
	{ file: "duckpaint.vt", title: "Duck Painting" },
	{ file: "zorro.vt", title: "The Story of Zorro, by Cian O'Kiersey" },
	{ file: "outerlimits.vt", title: "The Outer Limits" },
	{ file: "flatmap.vt", title: "Shifting Flat World Map" },
	{ file: "treadmill.vt", title: "The Treadmill, by GtB Productions (1993)" },
	{ file: "peace.vt", title: "Imagine World Peace, by John G. Poupore" },
	{ file: "maingate.vt", title: "The Disneyland Main Gate, by Don Bertino" },
	{ file: "monorail.vt", title: "Disneyland's Monorail, by Don Bertino" },
	{ file: "skyway.vt", title: "Disneyland's Skyway, by Don Bertino" },
	{ file: "tomorrw.vt", title: "Disneyland's Tomorrowland, by Don Bertino" },
	{ file: "mark_twain.vt", title: "The Mark Twain Ferry, by Don Bertino" },
	{ file: "castle.vt", title: "Fantasy in the Sky, by Don Bertino" },
	{ file: "fishy2.vt", title: "Shamus the Fish, by David Rybolt (1994)" },
	{ file: "van_halen.vt", title: "Van Halen's 5150, Animated" },
	{ file: "movglobe.vt", title: "Incredible Spinning, Moving Globe" },
	{ file: "moon.animation", title: "Winking Moon Says Good Evening" },
];

const HOLIDAYS: Animation[] = [
	{ file: "new_year.vt", title: "Happy New Year to You" },
	{ file: "valentin.vt", title: "Happy Valentine's Day" },
	{ file: "july.4.vt", title: "July 4th" },
	{ file: "hallow.vt", title: "Happy Halloween" },
	{ file: "mr_pumpkin", title: "Happy Halloween Pumpkin, by Mike Kamlet" },
	{ file: "turkey.vt", title: "Happy Thanksgiving" },
	{ file: "snowing.vt", title: "'Tis the Season: Merry Christmas" },
	{ file: "xmas.vt", title: "Merry Christmas" },
	{ file: "xmas-00.vt", title: "Santa Holds a Moving Sign" },
	{ file: "xmas-01.vt", title: "Starry Night, from Peter" },
	{ file: "xmas-02.vt", title: "A Bird Flies By, a Tree Grows" },
	{ file: "xmas-03.vt", title: "Tree, Train, Presents" },
	{ file: "xmas-04.vt", title: "Champagne Glass Filling, Jack-in-the-Box" },
	{ file: "xmas-05.vt", title: "Happy Holidays, by Peter" },
	{ file: "xmas-06.vt", title: "Hearth and Tree" },
	{ file: "xmas-07.vt", title: "A Christmas Card from MIS" },
	{ file: "xmas-08.vt", title: "Christmas Eve, 1992" },
	{ file: "xmas-09.vt", title: "Reindeer Land on the Roof" },
];

/** The rest of the archive: repeats, and some that are rude, cruel or in poor taste. */
const REST: Animation[] = [
	"bambi_godzila",
	"barney.vt",
	"beer.vt",
	"bevis.butthead.vt",
	"bomb.vt",
	"cert18.vt",
	"cow.vt",
	"cowboom.vt",
	"crash.vt",
	"delay.vt",
	"dirty.vt",
	"dogs.vt",
	"dont-wor.vt",
	"dontworry.vt",
	"monkey.vt",
	"paradise.vt",
	"prey_col.vt",
	"safesex.vt",
	"shuttle.vt",
	"snowing",
	"startrek.vt",
	"trekvid.vt",
	"tv.vt",
	"twilightzone.vt",
	"valentine.vt",
	"xmas.large",
	"xmas2.vt",
	"xmasshort.vt",
].map((file) => ({ file, title: file }));

function cacheDir(): string {
	return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "vt420-term", "animations");
}

/** The animation's bytes, fetched the first time; undefined where it cannot be had. */
async function load(animation: Animation): Promise<Buffer | undefined> {
	const path = join(cacheDir(), animation.file);
	if (existsSync(path)) return readFileSync(path);
	try {
		const response = await fetch(SOURCE + encodeURIComponent(animation.file), {
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) return undefined;
		const bytes = Buffer.from(await response.arrayBuffer());
		mkdirSync(cacheDir(), { recursive: true });
		writeFileSync(path, bytes);
		return bytes;
	} catch {
		return undefined;
	}
}

/** As a VT100's line had it: seven bits, and a line feed with its carriage return. */
function prepare(bytes: Buffer): string {
	let out = "";
	let previous = 0;
	for (const raw of bytes) {
		const byte = raw & 0x7f;
		if (byte === 0x0a && previous !== 0x0d) out += "\r";
		out += String.fromCharCode(byte);
		previous = byte;
	}
	return out;
}

/** A VT100 as the animations expect it, after whatever the last one left. */
const RESET = `${CSI}!p${CSI}?7h${CSI}?4l${CSI}?5l${CSI}?6l${CSI}r\x1b(B\x1b)0\x0f${CSI}m${CSI}?25h${CSI}H${CSI}2J`;

function status(text: string): string {
	return `${CSI}1$}\r${CSI}2K${text.slice(0, 80)}${CSI}0$}`;
}

const centred = (text: string, width: number): number => Math.max(1, Math.floor((width - text.length) / 2) + 1);

function card(index: number, count: number, animation: Animation, size: number, baud: number): string {
	const seconds = Math.round((size * 10) / baud);
	const title = animation.title.length <= 38 ? animation.title : animation.title.slice(0, 38);
	const lines = [`${animation.file}, ${Math.round(size / 1024)} KB`, `about ${seconds} s at ${baud} baud`];
	let out = `${RESET}${CSI}?25l`;
	out += `${CSI}9;1H\x1b#3${CSI}9;${centred(title, 40)}H${title}${CSI}10;1H\x1b#4${CSI}10;${centred(title, 40)}H${title}`;
	for (const [i, line] of lines.entries()) out += `${CSI}${13 + i * 2};${centred(line, 80)}H${line}`;
	out += `${CSI}20;${centred(`${index + 1} of ${count}`, 80)}H${index + 1} of ${count}`;
	return out;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("-h") || args.includes("--help")) {
		process.stdout.write(`vt420-animations: the classic VT100 animations, played at the speed they were made for

Usage: vt420-animations [options] [file...]

Animations come from artscene.textfiles.com/vt100 the first time, into ~/.cache/vt420-term/animations.

  --baud <n>    the line speed to play at (default 9600, as most were made for)
  --holidays    the seasonal ones too
  --all         the whole archive, the rude ones too
  --loop        start again after the last one
  --list        the playlist
  --fetch       fetch the playlist into the cache and stop

Keys: n or space the next one, p the one before, + and - faster and slower, q to stop.
`);
		return;
	}
	const value = (name: string): string | undefined => {
		const at = args.indexOf(name);
		return at >= 0 ? args[at + 1] : undefined;
	};
	let baud = Number(value("--baud") ?? 9600);
	if (!Number.isFinite(baud) || baud < 300) baud = 9600;
	const everything = [...PLAYLIST, ...HOLIDAYS, ...REST];
	const named = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--baud");
	const playlist =
		named.length > 0
			? named.map((file) => everything.find((animation) => animation.file === file) ?? { file, title: file })
			: [
					...PLAYLIST,
					...(args.includes("--holidays") || args.includes("--all") ? HOLIDAYS : []),
					...(args.includes("--all") ? REST : []),
				];
	if (args.includes("--list")) {
		for (const animation of playlist) process.stdout.write(`${animation.file.padEnd(18)} ${animation.title}\n`);
		return;
	}
	if (args.includes("--fetch")) {
		for (const animation of playlist) {
			process.stdout.write(`${animation.file} ${(await load(animation)) ? "ok" : "not to be had"}\n`);
		}
		return;
	}

	const tty = new Tty();
	let index = 0;
	let next: "next" | "previous" | "stop" | undefined;
	tty.onKey((key) => {
		if (key === "q" || key === "Q" || key === "\x03") next = "stop";
		else if (key === "n" || key === " " || key === "\r") next = "next";
		else if (key === "p") next = "previous";
		else if (key === "+" || key === "=") baud = SPEEDS.find((speed) => speed > baud) ?? baud;
		else if (key === "-") baud = [...SPEEDS].reverse().find((speed) => speed < baud) ?? baud;
	});
	const back = await snapshot(tty);
	await tty.send(`${CSI}2$~`);
	try {
		while (next !== "stop") {
			const animation = playlist[index]!;
			next = undefined;
			await tty.send(`${RESET}${status(` fetching ${animation.file}...`)}`);
			const bytes = await load(animation);
			if (!bytes) {
				await tty.send(status(` ${animation.file} could not be fetched; n next, q quit`));
				await sleep(1500);
			} else {
				await tty.send(card(index, playlist.length, animation, bytes.length, baud));
				for (let wait = 0; wait < 30 && !next; wait++) await sleep(100);
				if (!next)
					await play(
						tty,
						prepare(bytes),
						() => next !== undefined,
						() => baud,
						(speed) =>
							status(
								` ${index + 1}/${playlist.length} ${animation.file} at ${speed} baud   n next  p back  +/- speed  q quit`,
							),
					);
				for (let wait = 0; wait < 25 && !next; wait++) await sleep(100);
			}
			if (next === "stop") break;
			if (next === "previous") index = (index + playlist.length - 1) % playlist.length;
			else if (index + 1 < playlist.length) index++;
			else if (args.includes("--loop")) index = 0;
			else break;
		}
	} finally {
		await tty.send(`${RESET}${back}${CSI}1$}\r${CSI}2K${CSI}0$}`);
		await tty.drain();
		tty.close();
	}
	process.exit(0);
}

/** The bytes at the line speed, in pieces the terminal answers, until `stopped`. */
async function play(
	tty: Tty,
	text: string,
	stopped: () => boolean,
	speed: () => number,
	caption: (baud: number) => string,
): Promise<void> {
	let shownSpeed = 0;
	let start = Date.now();
	let sent = 0;
	for (const piece of pieces(text, 48)) {
		if (stopped()) return;
		const baud = speed();
		if (baud !== shownSpeed) {
			shownSpeed = baud;
			start = Date.now();
			sent = 0;
			await tty.send(caption(baud));
		}
		await tty.send(piece);
		sent += piece.length;
		// as fast as the line it was made for, and no faster
		const due = start + (sent * 10_000) / baud;
		const wait = due - Date.now();
		if (wait > 0) await sleep(wait);
	}
	await tty.drain();
}

await main();
