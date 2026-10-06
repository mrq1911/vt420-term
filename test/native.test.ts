import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RelayedNative, type RelayOptions } from "../src/native-client.ts";
import { socketPath } from "../src/native-protocol.ts";
import { FakeNative, settle } from "./fixtures.ts";

const HOST = new URL("../src/native-host.ts", import.meta.url).pathname;
const hosts: ChildProcess[] = [];

afterEach(() => {
	for (const host of hosts.splice(0)) host.kill();
});

/** The host as zellij's tab would run it, and a way to attach to it. */
async function hostedShell() {
	const runtimeDir = mkdtempSync(join(tmpdir(), "vt420-native-"));
	const uid = process.getuid!();
	const path = socketPath(runtimeDir, uid, "main");
	const options: RelayOptions = {
		// no tab is opened while the host listens
		zellij: "false",
		session: "main",
		host: [process.execPath, HOST],
		term: "vt420",
		columns: 80,
		rows: 24,
		cwd: runtimeDir,
		runtimeDir,
		uid,
		fallback: () => {
			throw new Error("the tab's host was there");
		},
	};
	// the directory as the client makes it, private
	new RelayedNative({ ...options, startMs: 0 }).kill();
	await settle(50);
	const host = spawn(process.execPath, [HOST, path], { env: { ...process.env, SHELL: "/bin/sh" }, stdio: "ignore" });
	hosts.push(host);
	for (let wait = 0; wait < 50 && !existsSync(path); wait++) await settle(50);
	const attach = () => {
		const native = new RelayedNative(options);
		const output: Buffer[] = [];
		const exits: number[] = [];
		native.onData((data) => output.push(data));
		native.onExit(({ exitCode }) => exits.push(exitCode));
		return { native, exits, text: () => Buffer.concat(output).toString("latin1") };
	};
	return { host, path, attach };
}

async function until(condition: () => boolean): Promise<void> {
	for (let wait = 0; wait < 60 && !condition(); wait++) await settle(50);
}

describe("native session kept by a host", () => {
	it("finds the same shell after a detach, and ends when it exits", async () => {
		const { host, path, attach } = await hostedShell();
		const first = attach();
		first.native.write("MARK=kept; echo ready-$((40+2))\n");
		await until(() => first.text().includes("ready-42"));
		expect(first.text()).toContain("ready-42");
		// vt420-term goes, with zellij detached: the shell stays with the host
		first.native.kill();
		await settle(200);
		expect(host.exitCode).toBeNull();
		const second = attach();
		second.native.write("echo mark-$MARK term-$TERM\n");
		await until(() => second.text().includes("mark-kept"));
		expect(second.text()).toContain("mark-kept term-vt420");
		second.native.write("exit\n");
		await until(() => second.exits.length > 0);
		expect(second.exits).toEqual([0]);
		await until(() => host.exitCode !== null);
		expect(existsSync(path)).toBe(false);
	}, 15_000);

	it("stands a shell of its own in when the tab cannot be had", async () => {
		const runtimeDir = mkdtempSync(join(tmpdir(), "vt420-native-"));
		const fallen = new FakeNative();
		const native = new RelayedNative({
			zellij: "false",
			session: "nowhere",
			host: ["false"],
			term: "vt420",
			columns: 80,
			rows: 24,
			cwd: runtimeDir,
			runtimeDir,
			uid: process.getuid!(),
			fallback: () => fallen,
			startMs: 200,
		});
		native.write("typed early");
		await until(() => fallen.input !== "");
		expect(fallen.input).toBe("typed early");
	});
});
