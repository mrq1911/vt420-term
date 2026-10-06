/**
 * vt420-term: run a program made for modern terminals, zellij first, on a DEC VT420.
 */

import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node-pty";
import { RelayedNative } from "./native-client.ts";
import { isSaverMode, type SaverMode } from "./saver.ts";
import { type NativeChild, Session } from "./session.ts";
import type { SupplementalSet } from "./vt420/charset.ts";
import { Vt420Terminal, type Vt420TerminalOptions } from "./vt420/terminal.ts";

const VERSION = "0.1.0";

const USAGE = `vt420-term: run a program made for modern terminals on a DEC VT420

Usage: vt420-term [options] [--] [command [args...]]

The program (your shell by default) runs in a pseudo-terminal that emulates xterm; the VT420 only ever receives
what vt420-term draws from that screen, in DEC character sets and attributes it has.

Program
      --term <name>         TERM for the program (default xterm-256color)
      --meta-key <key>      key that sends Alt with the next key: f6-f14, f17-f20, help, do or none (default f14)
      --show-keys           show each key's bytes, and what the program got, on the status line
      --status-row          give the program a row more than the screen and show its last one on the status line,
                            where a status bar such as zellij's leaves the whole screen to the rest
      --function-keys       send F11, F12 and F13 as xterm's F11, F12 and Shift+F1, for zellij to bind, rather than
                            Escape, BS and LF
      --native-key <key>    key (f6-f20, help or do) that switches the terminal between the program and a native
                            session: your shell straight on the terminal, on a page of its own, which a program made
                            for the VT420 draws on as it would without vt420-term
      --native-zellij       keep the native session in a tab of the zellij session the program is, so that it lasts
                            as long as the session: detached and attached again, F19 finds the same shell
      --screensaver <mode>  auto, off, blank or progress: a dark screen after a spell without keys (auto is progress
                            on a DEC terminal, off on emulators)
      --screensaver-minutes <n>  minutes without a key before it starts (default 10)

Terminal
      --columns 80|132      switch the terminal to 80 or 132 columns (DECSCPP)
      --lines 24|36|48      switch the number of screen lines (DECSNLS)
      --status-line <mode>  auto, on or off: the program's title on the host-writable status line
      --encoding <mode>     auto, dec or utf8: DEC character sets, or Unicode for emulators
      --double-size <mode>  auto, on or off (vt420-term itself never uses double-size lines)
      --latin1, --dec-mcs   supplemental set for G3 (default: the terminal's preference)
      --8bit                send supplemental glyphs as 8-bit GR codes
      --baud <n>            line speed for output pacing (detected on serial ports)
      --no-flow-control     do not keep XON/XOFF enabled
      --log <file>          append everything sent to the terminal to a file

  -h, --help                this help
  -v, --version             the version
`;

interface Args {
	terminal: Vt420TerminalOptions;
	term: string;
	metaKey: string;
	nativeKey?: string;
	nativeZellij: boolean;
	showKeys: boolean;
	statusRow: boolean;
	functionKeys: boolean;
	screensaver: SaverMode | "auto";
	screensaverMinutes?: number;
	command: string[];
}

function fail(message: string): never {
	process.stderr.write(`vt420-term: ${message}\n`);
	process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
	const args: Args = {
		terminal: {
			statusLine: "auto",
			doubleSize: "auto",
			encoding: "auto",
			supplemental: "auto",
			eightBit: false,
			flowControl: true,
			probeTimeoutMs: 1500,
			keypad: "application",
		},
		term: "xterm-256color",
		metaKey: "f14",
		showKeys: false,
		nativeZellij: false,
		statusRow: false,
		functionKeys: false,
		screensaver: "auto",
		command: [],
	};
	const mode = (arg: string, value: string, allowed: readonly string[]): string => {
		if (!allowed.includes(value)) fail(`${arg} must be ${allowed.join(", ")}`);
		return value;
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		const value = (): string => {
			const next = argv[++index];
			if (next === undefined) fail(`${arg} needs a value`);
			return next;
		};
		switch (arg) {
			case "--":
				args.command = argv.slice(index + 1);
				return args;
			case "--term":
				args.term = value();
				break;
			case "--meta-key":
				args.metaKey = mode(arg, value(), [
					"f6",
					"f7",
					"f8",
					"f9",
					"f10",
					"f11",
					"f12",
					"f13",
					"f14",
					"f17",
					"f18",
					"f19",
					"f20",
					"help",
					"do",
					"none",
				]);
				break;
			case "--native-key":
				args.nativeKey = mode(arg, value(), [
					"f6",
					"f7",
					"f8",
					"f9",
					"f10",
					"f11",
					"f12",
					"f13",
					"f14",
					"f17",
					"f18",
					"f19",
					"f20",
					"help",
					"do",
				]);
				break;
			case "--native-zellij":
				args.nativeZellij = true;
				break;
			case "--show-keys":
				args.showKeys = true;
				break;
			case "--status-row":
				args.statusRow = true;
				break;
			case "--function-keys":
				args.functionKeys = true;
				break;
			case "--screensaver": {
				const saver = value();
				if (saver !== "auto" && !isSaverMode(saver)) fail("--screensaver must be auto, off, blank or progress");
				args.screensaver = saver;
				break;
			}
			case "--screensaver-minutes": {
				const minutes = Number(value());
				if (!Number.isFinite(minutes) || minutes <= 0) fail("--screensaver-minutes needs a positive number");
				args.screensaverMinutes = minutes;
				break;
			}
			case "--columns": {
				const columns = Number(value());
				if (columns !== 80 && columns !== 132) fail("--columns must be 80 or 132");
				args.terminal.columns = columns;
				break;
			}
			case "--lines": {
				const lines = Number(value());
				if (lines !== 24 && lines !== 36 && lines !== 48) fail("--lines must be 24, 36 or 48");
				args.terminal.lines = lines;
				break;
			}
			case "--status-line":
				args.terminal.statusLine = mode(arg, value(), ["auto", "on", "off"]) as "auto" | "on" | "off";
				break;
			case "--encoding":
				args.terminal.encoding = mode(arg, value(), ["auto", "dec", "utf8"]) as "auto" | "dec" | "utf8";
				break;
			case "--double-size":
				args.terminal.doubleSize = mode(arg, value(), ["auto", "on", "off"]) as "auto" | "on" | "off";
				break;
			case "--latin1":
			case "--dec-mcs":
				args.terminal.supplemental = (arg === "--latin1" ? "latin1" : "dec") as SupplementalSet;
				break;
			case "--8bit":
				args.terminal.eightBit = true;
				break;
			case "--baud": {
				const baud = Number(value());
				if (!Number.isFinite(baud) || baud <= 0) fail("--baud needs a positive number");
				args.terminal.baud = baud;
				break;
			}
			case "--no-flow-control":
				args.terminal.flowControl = false;
				break;
			case "--log":
				args.terminal.logPath = value();
				break;
			case "-h":
			case "--help":
				process.stdout.write(USAGE);
				process.exit(0);
				break;
			case "-v":
			case "--version":
				process.stdout.write(`${VERSION}\n`);
				process.exit(0);
				break;
			default:
				if (arg.startsWith("-") && arg !== "-") fail(`unknown option ${arg}`);
				args.command = argv.slice(index);
				return args;
		}
	}
	return args;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const [command, ...commandArgs] = args.command.length > 0 ? args.command : [process.env.SHELL || "/bin/sh"];
	const terminal = await Vt420Terminal.open(args.terminal);
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(command!, commandArgs, {
			name: args.term,
			cols: terminal.caps.columns,
			rows: terminal.caps.rows + (args.statusRow && terminal.caps.statusLine ? 1 : 0),
			cwd: process.cwd(),
			// programs made for the VT420, pi-vt420 among them, learn what they really draw on; ssh passes LC_ variables on
			env: { ...process.env, TERM: args.term, VT420_TERM: terminal.caps.name, LC_VT420_TERM: terminal.caps.name },
		});
	} catch (error) {
		terminal.close();
		fail(`cannot start ${command}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const finish = (code: number): never => {
		terminal.close();
		process.exit(code);
	};
	for (const signal of ["SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => {
			child.kill(signal);
			finish(signal === "SIGHUP" ? 129 : 143);
		});
	}
	process.on("uncaughtException", (error) => {
		child.kill();
		terminal.close();
		process.stderr.write(`vt420-term: ${error.stack ?? error.message}\n`);
		process.exit(1);
	});
	const session = new Session(terminal, child, {
		metaKey: args.metaKey,
		nativeKey: args.nativeKey,
		spawnNative: ({ title, bar }) => {
			const shell = (): NativeChild => {
				// straight on the terminal: its own TERM, and nothing saying an emulator is in between
				const env = { ...process.env };
				for (const name of ["VT420_TERM", "LC_VT420_TERM"]) delete env[name];
				// with no encoding node-pty passes Buffers, which its typings, written for strings, do not say
				return spawn(process.env.SHELL || "/bin/sh", [], {
					name: process.env.TERM || "vt420",
					cols: terminal.caps.columns,
					rows: terminal.caps.rows,
					cwd: process.cwd(),
					env,
					encoding: null,
				}) as unknown as NativeChild;
			};
			// zellij calls its window "session | pane title", though not until something changes after an attach;
			// its compact bar says "Zellij (session)" from the start
			const zellijSession = args.nativeZellij
				? title.split(" | ")[0]?.trim() || /Zellij \(([^)]+)\)/.exec(bar)?.[1]
				: undefined;
			if (!zellijSession) return shell();
			return new RelayedNative({
				zellij: args.command[0]!,
				session: zellijSession,
				host: [process.execPath, fileURLToPath(new URL("./native-host.ts", import.meta.url))],
				term: process.env.TERM || "vt420",
				columns: terminal.caps.columns,
				rows: terminal.caps.rows,
				cwd: process.cwd(),
				runtimeDir: process.env.XDG_RUNTIME_DIR || tmpdir(),
				uid: process.getuid?.() ?? 0,
				fallback: shell,
			});
		},
		showKeys: args.showKeys,
		statusRow: args.statusRow,
		functionKeys: args.functionKeys,
		screensaver: args.screensaver,
		screensaverMinutes: args.screensaverMinutes,
	});
	finish(await session.run());
}

await main();
