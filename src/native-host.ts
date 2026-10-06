/**
 * vt420-native-host: keeps the native session in a tab of a zellij session, so it lasts as long as the session
 * rather than as long as vt420-term. It owns the shell's pseudo-terminal and passes its bytes, untouched, to the
 * vt420-term attached through a Unix socket; zellij only keeps it running and shows a note in its tab.
 *
 * With nothing attached the program's output is dropped, as dtach does, and the next attach resizes the
 * pseudo-terminal so the program draws itself again. The tab closes when the shell exits.
 */

import { chmodSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { spawn } from "node-pty";
import { Frames, type Message, send } from "./native-protocol.ts";

/** The pseudo-terminal, which with no encoding passes Buffers whatever node-pty's typings say. */
interface Shell {
	onData(listener: (data: Buffer) => void): void;
	onExit(listener: (event: { exitCode: number }) => void): void;
	write(data: Buffer): void;
	resize(columns: number, rows: number): void;
	pause(): void;
	resume(): void;
	kill(signal?: string): void;
}

const path = process.argv[2];
if (!path) {
	process.stderr.write("usage: vt420-native-host <socket>\n");
	process.exit(2);
}

let shell: Shell | undefined;
let client: Socket | undefined;

function note(text: string): void {
	process.stdout.write(`\x1b[H\x1b[2J${text}\r\n`);
}

function startShell(hello: { columns: number; rows: number; term: string }): Shell {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
	// straight on the VT420: its own TERM, and nothing saying zellij or an emulator is in between
	for (const name of ["ZELLIJ", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID", "VT420_TERM", "LC_VT420_TERM", "COLORTERM"]) {
		delete env[name];
	}
	env.TERM = hello.term;
	const started = spawn(process.env.SHELL || "/bin/sh", [], {
		name: hello.term,
		cols: hello.columns,
		rows: hello.rows,
		cwd: process.cwd(),
		env,
		encoding: null,
	}) as unknown as Shell;
	started.onData((data) => {
		if (client) send(client, "d", data);
	});
	started.onExit(({ exitCode }) => {
		if (client) send(client, "x", Buffer.from(String(exitCode)));
		finish(0);
	});
	return started;
}

function receive(socket: Socket, message: Message): void {
	if (socket !== client) return;
	switch (message.type) {
		case "h": {
			const hello = JSON.parse(message.data.toString("utf8")) as { columns: number; rows: number; term: string };
			if (!shell) shell = startShell(hello);
			else {
				// attached again: a size that changes has the program draw itself again
				const again = shell;
				again.resize(hello.columns, Math.max(1, hello.rows - 1));
				setTimeout(() => again.resize(hello.columns, hello.rows), 50);
			}
			note("The VT420's native session lives in this tab, shown on the terminal itself: F19 there.");
			return;
		}
		case "i":
			shell?.write(message.data);
			return;
		case "r": {
			const [columns = 80, rows = 24] = message.data.toString("latin1").split(",").map(Number);
			shell?.resize(columns, rows);
			return;
		}
		case "p":
			shell?.pause();
			return;
		case "u":
			shell?.resume();
			return;
	}
}

const server = createServer((socket) => {
	// the newest vt420-term is the one attached
	client?.destroy();
	client = socket;
	const frames = new Frames((message) => receive(socket, message));
	socket.on("data", (chunk: Buffer) => frames.push(chunk));
	const detach = (): void => {
		if (client !== socket) return;
		client = undefined;
		// nothing waits for the output now: the program runs on, and draws itself again on the next attach
		shell?.resume();
		note("The VT420's native session lives in this tab, detached: F19 on the terminal attaches it again.");
	};
	socket.on("close", detach);
	socket.on("error", detach);
});

function finish(code: number): never {
	try {
		unlinkSync(path!);
	} catch {}
	process.exit(code);
}

for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		shell?.kill("SIGHUP");
		finish(0);
	});
}

try {
	unlinkSync(path);
} catch {}
server.listen(path, () => {
	chmodSync(path!, 0o600);
	note("The VT420's native session lives in this tab: F19 on the terminal shows it.");
});
