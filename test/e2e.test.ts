import { execFileSync } from "node:child_process";
import { spawn } from "node-pty";
import { describe, expect, it } from "vitest";
import { Vt420Emulator } from "./emulator.ts";
import { settle } from "./fixtures.ts";
import { vt420Violations } from "./safety.ts";

/** The real CLI on a pseudo-terminal, with the emulator as the VT420 at the other end, answering its probe. */
function run(args: string[], env: Record<string, string> = {}) {
	const emulator = new Vt420Emulator({ rows: 24, columns: 80, onResponse: (bytes) => child.write(bytes) });
	const chunks: Buffer[] = [];
	const environment: Record<string, string> = { ...(process.env as Record<string, string>), ...env };
	for (const name of ["ZELLIJ", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID"]) delete environment[name];
	const child = spawn("node", ["src/main.ts", ...args], {
		name: "vt420",
		cols: 80,
		rows: 24,
		cwd: process.cwd(),
		env: environment,
		encoding: null,
	});
	child.onData((data) => {
		const chunk = Buffer.from(data as unknown as Uint8Array);
		chunks.push(chunk);
		emulator.feed(chunk);
	});
	const exited = new Promise<number>((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)));
	return { emulator, child, exited, bytes: () => Buffer.concat(chunks) };
}

const hasZellij = (() => {
	try {
		execFileSync("zellij", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

describe("vt420-term end to end", () => {
	it("runs a program on the VT420 and passes its exit code on", async () => {
		const script = String.raw`printf '\e]2;hostile\a\e[1;38;5;154mgreen\e[0m \e[48;5;154m lit \e[0m ü ≥ 漢 \U1f680\n\e_Gq=1\e\\after\n'; head -c 200 /dev/urandom | tr -d '\033'; sleep 1; exit 7`;
		const vt420 = run(["--", "bash", "-c", script]);
		await settle(900);
		expect(vt420.emulator.text(0)).toBe("green  lit  ü ≥ ?  ?");
		expect(vt420.emulator.text(1)).toBe("after");
		expect(vt420.emulator.statusText()).toMatch(/hostile$/);
		expect(await vt420.exited).toBe(7);
		expect(vt420Violations(vt420.bytes())).toEqual([]);
	}, 20_000);

	it.skipIf(!hasZellij)(
		"runs zellij with the VT420 profile",
		async () => {
			const session = `vt420-test-${process.pid}`;
			// a plain shell in the panes, and zellij-vt420-help on the PATH as bin/zellij-vt420 puts it there
			const vt420 = run(
				["--status-row", "--function-keys", "--", "zellij", "--config", "zellij/vt420.kdl", "--session", session],
				{
					SHELL: "/bin/sh",
					PATH: `${process.cwd()}/bin:${process.env.PATH}`,
				},
			);
			const screen = (): string => vt420.emulator.screen().join("\n");
			try {
				await settle(4000);
				// the compact bar, with the session, on the status line, and the screen's last row the pane's
				const status = (): string => vt420.emulator.statusText();
				expect(status()).toContain("Zellij");
				expect(status()).toContain(session);
				expect(vt420.emulator.screen()[23]).not.toContain("Zellij");
				const press = async (keys: string): Promise<void> => {
					vt420.child.write(keys);
					await settle(500);
				};
				// PF1 alone is the program's; F12 is pane mode, and again back; Do is session mode, F11 leaves it
				await press("\x1bOP");
				expect(status()).toContain("NORMAL");
				await press("\x1b[24~");
				expect(status()).toContain("PANE");
				await press("\x1b[24~");
				expect(status()).toContain("NORMAL");
				await press("\x1b[29~");
				expect(status()).toContain("SESSION");
				await press("\x1b[23~");
				expect(status()).toContain("NORMAL");
				// F14 then PF1 is pane mode too; F13 goes from there to tab mode
				await press("\x1b[26~\x1bOP");
				expect(status()).toContain("PANE");
				await press("\x1b[25~");
				expect(status()).toContain("TAB");
				await press("\x1b[23~");
				// F11 locks, and again unlocks
				await press("\x1b[23~");
				expect(status()).toContain("LOCKED");
				await press("\x1b[23~");
				expect(status()).toContain("NORMAL");
				// F19 opens a pane, and Help alone shows the keys
				await press("\x1b[33~");
				await settle(1000);
				expect(screen().match(/│/g)?.length ?? 0).toBeGreaterThan(10);
				await press("\x1b[28~");
				await settle(1000);
				expect(screen()).toContain("LK401 keys in zellij");
				expect(vt420Violations(vt420.bytes())).toEqual([]);
			} finally {
				vt420.child.kill();
				try {
					execFileSync("zellij", ["kill-session", session], { stdio: "ignore" });
				} catch {}
				try {
					execFileSync("zellij", ["delete-session", session, "--force"], { stdio: "ignore" });
				} catch {}
			}
		},
		30_000,
	);
});
