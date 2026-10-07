/**
 * Runs vt420-probe against the VT420's own firmware, V1.4 as on the terminal it was recorded on, in Blaze, an
 * emulator of the terminal's hardware (github.com/mmastrac/blaze), and keeps its answers as a recording for the
 * conformance test, beside the one from the terminal. Cases the terminal never ran can be answered this way.
 *
 *   cargo build --release --no-default-features --features vram-dump    (in a Blaze checkout)
 *   BLAZE=~/src/blaze node scripts/firmware-probe.ts [test/fixtures/vt420-firmware.json]
 *
 * The firmware starts with its settings memory all zeros, which it takes for valid settings, not the factory's (erased
 * memory stops it at "NVR Error - 1"); the conformance test sets vt420 up as the recording reports. ROM picks other
 * firmware.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const blaze = process.env.BLAZE;
if (!blaze) {
	process.stderr.write("firmware-probe: BLAZE must name a Blaze checkout with blaze-vt built in it\n");
	process.exit(2);
}
const repo = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(repo, "test/fixtures/vt420-firmware.json"));
const rom = process.env.ROM ?? join(blaze, "roms/vt420/23-208E9-00.bin");
const probe = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(repo, "src/probe.ts"))} --pipe ${JSON.stringify(out)}`;

rmSync(out, { force: true });
const emulator = spawn(
	join(blaze, "target/release/blaze-vt"),
	["--rom", rom, "--display", "headless", "--skip-diagnostics", "--comm1", `exec --no-pty ${JSON.stringify(probe)}`],
	{ stdio: ["ignore", "ignore", "inherit"] },
);
emulator.on("exit", (code) => {
	if (!existsSync(out)) {
		process.stderr.write(`firmware-probe: blaze stopped (${code}) before the probe was done\n`);
		process.exit(1);
	}
});

// the probe writes its file once, at the end; a file that stops growing is done
const started = Date.now();
let size = -1;
for (;;) {
	await new Promise((done) => setTimeout(done, 500));
	if (Date.now() - started > 20 * 60_000) {
		emulator.kill();
		process.stderr.write("firmware-probe: no answers after 20 minutes\n");
		process.exit(1);
	}
	if (!existsSync(out)) continue;
	const now = statSync(out).size;
	if (now > 0 && now === size) break;
	size = now;
}
emulator.kill();
// which firmware answered, first
const recording = JSON.parse(readFileSync(out, "utf8"));
writeFileSync(out, `${JSON.stringify({ firmware: basename(rom), ...recording }, null, "\t")}\n`);
process.stdout.write(`firmware-probe: ${out}, in ${Math.round((Date.now() - started) / 1000)} s\n`);
process.exit(0);
