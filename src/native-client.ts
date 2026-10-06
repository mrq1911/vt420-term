/**
 * The native session kept in a tab of the zellij session, as vt420-term sees it: a NativeChild that attaches to
 * vt420-native-host over its socket, opening the tab first when the session has none. Killing it only detaches; the
 * tab keeps the program until it exits or the zellij session ends. Where the tab cannot be had, a shell of
 * vt420-term's own stands in, as without zellij.
 */

import { execFile } from "node:child_process";
import { lstatSync, mkdirSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";
import { Frames, send, socketPath } from "./native-protocol.ts";
import type { NativeChild } from "./session.ts";

export interface RelayOptions {
	/** The zellij that runs the session, and the session's name. */
	zellij: string;
	session: string;
	/** The command that starts vt420-native-host, its socket's path added. */
	host: string[];
	term: string;
	columns: number;
	rows: number;
	cwd: string;
	runtimeDir: string;
	uid: number;
	/** A shell of vt420-term's own, for when the tab cannot be had. */
	fallback: () => NativeChild;
	/** How long to wait for a new tab's host to listen. */
	startMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function attempt(path: string): Promise<Socket | undefined> {
	return new Promise((resolve) => {
		const socket = connect(path);
		socket.once("connect", () => resolve(socket));
		socket.once("error", () => resolve(undefined));
	});
}

/** A directory for the sockets that only this user can enter, or an error. */
function privateDirectory(path: string, uid: number): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
		throw new Error(`${path} is not a private directory`);
	}
}

export class RelayedNative implements NativeChild {
	private readonly options: RelayOptions;
	private socket: Socket | undefined;
	private fallen: NativeChild | undefined;
	private readonly dataListeners: Array<(data: Buffer) => void> = [];
	private readonly exitListeners: Array<(event: { exitCode: number }) => void> = [];
	private readonly queued: Buffer[] = [];
	private size: [number, number];
	private paused = false;
	private closed = false;
	private exited = false;

	constructor(options: RelayOptions) {
		this.options = options;
		this.size = [options.columns, options.rows];
		void this.start().catch(() => this.fallBack());
	}

	onData(listener: (data: Buffer) => void): void {
		this.dataListeners.push(listener);
		this.fallen?.onData(listener);
	}

	onExit(listener: (event: { exitCode: number; signal?: number }) => void): void {
		this.exitListeners.push(listener);
		this.fallen?.onExit(listener);
	}

	write(data: string | Buffer): void {
		const bytes = typeof data === "string" ? Buffer.from(data, "latin1") : data;
		if (this.fallen) this.fallen.write(bytes);
		else if (this.socket) send(this.socket, "i", bytes);
		else this.queued.push(bytes);
	}

	resize(columns: number, rows: number): void {
		this.size = [columns, rows];
		if (this.fallen) this.fallen.resize(columns, rows);
		else if (this.socket) send(this.socket, "r", `${columns},${rows}`);
	}

	pause(): void {
		this.paused = true;
		if (this.fallen) this.fallen.pause();
		else if (this.socket) send(this.socket, "p");
	}

	resume(): void {
		this.paused = false;
		if (this.fallen) this.fallen.resume();
		else if (this.socket) send(this.socket, "u");
	}

	/** vt420-term is done with it: detach, and leave the program to the tab. */
	kill(): void {
		this.closed = true;
		if (this.fallen) this.fallen.kill();
		else this.socket?.end();
	}

	private async start(): Promise<void> {
		const { runtimeDir, uid, session } = this.options;
		const path = socketPath(runtimeDir, uid, session);
		privateDirectory(dirname(path), uid);
		let socket = await attempt(path);
		if (!socket) {
			await this.openTab(path);
			const deadline = Date.now() + (this.options.startMs ?? 8000);
			while (!socket && !this.closed && Date.now() < deadline) {
				await sleep(100);
				socket = await attempt(path);
			}
		}
		if (this.closed) {
			socket?.end();
			return;
		}
		if (!socket) throw new Error("no native host");
		this.attach(socket);
	}

	private attach(socket: Socket): void {
		this.socket = socket;
		const frames = new Frames((message) => {
			if (message.type === "d") for (const listener of this.dataListeners) listener(message.data);
			else if (message.type === "x") this.exit(Number(message.data.toString("latin1")) || 0);
		});
		socket.on("data", (chunk: Buffer) => frames.push(chunk));
		// the tab closed or its host died: as far as vt420-term goes, the program ended
		socket.on("close", () => {
			if (!this.closed) this.exit(0);
		});
		socket.on("error", () => undefined);
		const [columns, rows] = this.size;
		send(socket, "h", JSON.stringify({ columns, rows, term: this.options.term }));
		if (this.paused) send(socket, "p");
		for (const bytes of this.queued.splice(0)) send(socket, "i", bytes);
	}

	/** A tab named native at the end of the session's tabs, the focus put back where it was. */
	private async openTab(path: string): Promise<void> {
		const { zellij, session, host, cwd } = this.options;
		const env: Record<string, string> = {};
		for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
		for (const name of ["ZELLIJ", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID"]) delete env[name];
		const run = (...args: string[]): Promise<string> =>
			new Promise((resolve, reject) => {
				execFile(zellij, ["--session", session, "action", ...args], { env, timeout: 5000 }, (error, stdout) =>
					error ? reject(error) : resolve(stdout),
				);
			});
		let active: number | undefined;
		try {
			const tabs = JSON.parse(await run("list-tabs", "--state", "--json")) as Array<{
				position: number;
				active: boolean;
			}>;
			active = tabs.find((tab) => tab.active)?.position;
		} catch {}
		await run("new-tab", "--name", "native", "--close-on-exit", "--cwd", cwd, "--", ...host, path);
		if (active !== undefined) await run("go-to-tab", String(active + 1)).catch(() => undefined);
	}

	private fallBack(): void {
		if (this.closed || this.fallen) return;
		const fallen = this.options.fallback();
		this.fallen = fallen;
		for (const listener of this.dataListeners) fallen.onData(listener);
		for (const listener of this.exitListeners) fallen.onExit(listener);
		fallen.resize(...this.size);
		if (this.paused) fallen.pause();
		for (const bytes of this.queued.splice(0)) fallen.write(bytes);
	}

	private exit(exitCode: number): void {
		if (this.exited) return;
		this.exited = true;
		for (const listener of this.exitListeners) listener({ exitCode });
	}
}
