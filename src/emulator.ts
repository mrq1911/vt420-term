/**
 * vt420: a DEC VT420 in a browser window. This side runs the program in a pseudo-terminal and serves the page,
 * which is the terminal: it takes the program's bytes over a WebSocket, draws them, and sends back keys and answers.
 */

import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node-pty";
import { WebSocket } from "./ws.ts";

const VERSION = "0.1.0";

const USAGE = `vt420: a DEC VT420 in a browser window, running your shell or a program

Usage: vt420 [options] [--] [command [args...]]

A local page is the terminal: page memory, the status line, double-size lines, smooth scroll, soft fonts,
user-defined keys, and the controls and reports of the VT420 programmer reference. Ctrl+F3 opens Set-Up, where
what follows can be changed too; the page keeps it.

Terminal
      --columns 80|132       columns at power-up
      --lines 24|36|48       lines at power-up
      --status-line <type>   none, indicator or host (the status line at power-up; default indicator)
      --smooth-scroll        smooth scroll at power-up
      --latin1               ISO Latin-1 as the user-preferred supplemental set (default DEC Supplemental)
      --8bit                 8-bit controls in what the terminal sends
      --vt100                VT100 mode
      --utf8                 take bytes from 0x80 as UTF-8, as no VT420 would, for programs that know no other
      --baud <n>             take the program's output no faster than a serial line at this speed
      --phosphor <colour>    white, green or amber

Program
      --term <name>          TERM for the program (default vt420)
      --demo                 run vt420-demo, a tour of the terminal, round and round
      --animations           run vt420-animations, the classic VT100 animations, round and round

Window
      --port <n>             the port on 127.0.0.1 (default: any free one)
      --no-open              print the page's address instead of opening it
      --browser <command>    open the address with this command
      --keep                 keep the program when the window closes, for the next one to show

  -h, --help                 this help
  -v, --version              the version
`;

interface Args {
	setup: Record<string, unknown>;
	display: Record<string, unknown>;
	term: string;
	port: number;
	open: boolean;
	browser?: string;
	keep: boolean;
	command: string[];
}

/** The pseudo-terminal, which with no encoding passes Buffers whatever node-pty's typings say. */
interface Child {
	onData(listener: (data: Buffer) => void): void;
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
	write(data: Buffer): void;
	resize(columns: number, rows: number): void;
	pause(): void;
	resume(): void;
	kill(signal?: string): void;
}

function fail(message: string): never {
	process.stderr.write(`vt420: ${message}\n`);
	process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
	const args: Args = { setup: {}, display: {}, term: "vt420", port: 0, open: true, keep: false, command: [] };
	const value = (index: number, name: string): string => {
		const next = argv[index + 1];
		if (next === undefined) fail(`${name} needs a value`);
		return next;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		switch (arg) {
			case "--columns": {
				const columns = Number(value(i++, arg));
				if (columns !== 80 && columns !== 132) fail("--columns is 80 or 132");
				args.setup.columns = columns;
				break;
			}
			case "--lines": {
				const lines = Number(value(i++, arg));
				if (![24, 36, 48].includes(lines)) fail("--lines is 24, 36 or 48");
				args.setup.lines = lines;
				break;
			}
			case "--status-line": {
				const type = ["none", "indicator", "host"].indexOf(value(i++, arg));
				if (type < 0) fail("--status-line is none, indicator or host");
				args.setup.statusDisplay = type;
				break;
			}
			case "--smooth-scroll":
				args.setup.smoothScroll = true;
				break;
			case "--latin1":
				args.setup.userPreferred = "latin1";
				break;
			case "--8bit":
				args.setup.eightBitControls = true;
				break;
			case "--vt100":
				args.setup.level = 1;
				break;
			case "--utf8":
				args.display.utf8 = true;
				break;
			case "--baud": {
				const baud = Number(value(i++, arg));
				if (!Number.isInteger(baud) || baud < 300) fail("--baud is a line speed such as 9600");
				args.display.baud = baud;
				break;
			}
			case "--phosphor": {
				const phosphor = value(i++, arg);
				if (!["white", "green", "amber"].includes(phosphor)) fail("--phosphor is white, green or amber");
				args.display.phosphor = phosphor;
				break;
			}
			case "--term":
				args.term = value(i++, arg);
				break;
			case "--demo":
				args.command = [fileURLToPath(new URL("../bin/vt420-demo", import.meta.url)), "--loop"];
				break;
			case "--animations":
				args.command = [fileURLToPath(new URL("../bin/vt420-animations", import.meta.url)), "--loop"];
				break;
			case "--port":
				args.port = Number(value(i++, arg));
				if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) fail("--port is 1-65535");
				break;
			case "--no-open":
				args.open = false;
				break;
			case "--browser":
				args.browser = value(i++, arg);
				break;
			case "--keep":
				args.keep = true;
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
			case "--":
				args.command = argv.slice(i + 1);
				return args;
			default:
				if (arg.startsWith("-")) fail(`unknown option ${arg} (see --help)`);
				args.command = argv.slice(i);
				return args;
		}
	}
	return args;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** What the page may load: its own files, the terminal, and the character sets it shares with vt420-term. */
const SERVED =
	/^\/src\/(web\/[a-z0-9-]+\.(ts|css|html)|web\/fonts\/[A-Za-z0-9-]+\.(ttf|txt)|emu\/[a-z0-9-]+\.ts|vt420\/(charset|cells)\.ts)$/;

const TYPES: Readonly<Record<string, string>> = {
	".ts": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".ttf": "font/ttf",
	".txt": "text/plain; charset=utf-8",
};

/** Modules with their types stripped, by path and modification time. */
const stripped = new Map<string, { mtime: number; code: string }>();

function serveFile(path: string, response: ServerResponse): void {
	const file = normalize(join(ROOT, path));
	if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
		response.writeHead(404).end();
		return;
	}
	let body: Buffer | string;
	try {
		if (extname(file) === ".ts") {
			const mtime = statSync(file).mtimeMs;
			const cached = stripped.get(file);
			if (cached?.mtime === mtime) body = cached.code;
			else {
				body = stripTypeScriptTypes(readFileSync(file, "utf8"));
				stripped.set(file, { mtime, code: body });
			}
		} else body = readFileSync(file);
	} catch {
		response.writeHead(404).end();
		return;
	}
	response.writeHead(200, {
		"content-type": TYPES[extname(file)] ?? "application/octet-stream",
		"cache-control": "no-cache",
	});
	response.end(body);
}

/** A browser that opens a page as an app window of its own, or else whatever opens pages here. */
function opener(url: string, browser: string | undefined): [string, string[]] {
	if (browser) return ["/bin/sh", ["-c", `${browser} "$1"`, "sh", url]];
	for (const name of [
		"chromium",
		"chromium-browser",
		"google-chrome",
		"google-chrome-stable",
		"brave",
		"brave-browser",
		"microsoft-edge",
	]) {
		if (spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0) {
			return [name, [`--app=${url}`, "--window-size=1120,900"]];
		}
	}
	return process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
}

function main(): void {
	process.removeAllListeners("warning");
	const args = parseArgs(process.argv.slice(2));
	const token = randomBytes(16).toString("hex");
	let child: Child | undefined;
	let exitCode: number | undefined;
	let page: WebSocket | undefined;
	let gone: NodeJS.Timeout | undefined;
	/** The program's output since it started, for a page that comes back, up to the last megabyte. */
	const history: Buffer[] = [];
	let historyBytes = 0;
	let port = 0;

	const hostOk = (request: IncomingMessage): boolean =>
		request.headers.host === `127.0.0.1:${port}` || request.headers.host === `localhost:${port}`;

	const server = createServer((request, response) => {
		if (!hostOk(request)) {
			response.writeHead(403).end();
			return;
		}
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		if (path === "/") serveFile("/src/web/index.html", response);
		else if (SERVED.test(path)) serveFile(path, response);
		else response.writeHead(404).end();
	});

	const startProgram = (columns: number, rows: number): void => {
		const env: Record<string, string> = {};
		for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
		// the terminal is the VT420 itself, not one behind vt420-term or a modern emulator
		for (const name of ["VT420_TERM", "LC_VT420_TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"])
			delete env[name];
		env.TERM = args.term;
		const [file, ...rest] = args.command.length > 0 ? args.command : [process.env.SHELL || "/bin/sh"];
		child = spawn(file!, rest, {
			name: args.term,
			cols: columns,
			rows,
			cwd: process.cwd(),
			env,
			encoding: null,
		}) as unknown as Child;
		child.onData((data) => {
			history.push(data);
			historyBytes += data.length;
			while (historyBytes > 1024 * 1024 && history.length > 1) historyBytes -= history.shift()!.length;
			page?.sendBinary(data);
		});
		child.onExit(({ exitCode: code }) => {
			exitCode = code;
			page?.sendText(JSON.stringify({ type: "exit", code }));
			setTimeout(() => process.exit(code), 200);
		});
	};

	server.on("upgrade", (request, socket) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const origin = request.headers.origin;
		// a page elsewhere, or a name that only resolves here, gets no shell
		if (
			!hostOk(request) ||
			url.pathname !== "/ws" ||
			url.searchParams.get("t") !== token ||
			(origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`)
		) {
			socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
			return;
		}
		const ws = WebSocket.accept(request, socket);
		if (!ws) return;
		// the newest page is the terminal; one before it is told so and let go
		if (page?.open) {
			page.sendText(JSON.stringify({ type: "taken" }));
			page.close();
		}
		page = ws;
		if (gone) clearTimeout(gone);
		ws.sendText(JSON.stringify({ type: "hello", setup: args.setup, display: args.display, version: VERSION }));
		if (child && history.length > 0) {
			ws.sendText(JSON.stringify({ type: "replay" }));
			for (const chunk of history) ws.sendBinary(chunk);
			ws.sendText(JSON.stringify({ type: "live" }));
		}
		if (exitCode !== undefined) ws.sendText(JSON.stringify({ type: "exit", code: exitCode }));
		ws.on({
			binary: (data) => child?.write(data),
			text: (text) => {
				let message: { type?: string; columns?: number; lines?: number };
				try {
					message = JSON.parse(text);
				} catch {
					return;
				}
				const columns = Math.max(2, Math.min(255, Math.floor(message.columns ?? 80)));
				const lines = Math.max(2, Math.min(255, Math.floor(message.lines ?? 24)));
				if (message.type === "ready" && !child) startProgram(columns, lines);
				else if (message.type === "resize") child?.resize(columns, lines);
				else if (message.type === "pause") child?.pause();
				else if (message.type === "resume") child?.resume();
			},
			close: () => {
				if (page !== ws) return;
				page = undefined;
				child?.resume();
				// a reload comes back at once; a closed window hangs the program up, as closing a terminal does
				if (!args.keep)
					gone = setTimeout(() => {
						child?.kill("SIGHUP");
						process.exit(exitCode ?? 0);
					}, 15_000);
			},
		});
	});

	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => {
			child?.kill("SIGHUP");
			process.exit(1);
		});
	}

	server.listen(args.port, "127.0.0.1", () => {
		const address = server.address();
		port = typeof address === "object" && address ? address.port : args.port;
		const url = `http://127.0.0.1:${port}/?t=${token}`;
		process.stderr.write(`vt420: ${url}\n`);
		if (!args.open) return;
		const [command, commandArgs] = opener(url, args.browser);
		const launched = spawnProcess(command, commandArgs, { detached: true, stdio: "ignore" });
		launched.on("error", () => process.stderr.write("vt420: no browser to open it with; open the address above\n"));
		launched.unref();
	});
}

main();
