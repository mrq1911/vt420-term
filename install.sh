#!/usr/bin/env bash
# Install or update vt420-term from this checkout: the dependencies, node-pty's native module, and the commands
# vt420-term and zellij-vt420 in ~/.local/bin. Linked as vt420-term-update. vt420 itself, in a browser window, and
# vt420-probe, vt420-demo and vt420-animations come from github.com/mrq1911/vt420.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
BIN="${VT420_TERM_BIN:-$HOME/.local/bin}"
cd "$ROOT"

if [[ "${1:-}" != "--no-pull" ]] && git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
	before="$(git rev-parse HEAD)"
	git pull --ff-only --quiet
	after="$(git rev-parse HEAD)"
	if [[ "$before" != "$after" ]]; then git log --oneline "$before..$after" | head -20; fi
fi

# the node this runs with is the one node-pty is built for, so the commands keep to it whatever node PATH finds later;
# where PATH finds one too old, the one of the last install
recent() {
	[[ -x "$1" ]] && "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)'
}
node="$(readlink -f "$(command -v node || echo none)")"
if ! recent "$node"; then
	node="$(cat node_modules/.vt420-term-node 2>/dev/null || echo none)"
	if ! recent "$node"; then
		echo "vt420-term needs node 22.18 or newer on PATH" >&2
		exit 1
	fi
fi
# its npm, and node-gyp under it, build for it
export PATH="$(dirname "$node"):$PATH"

# lifecycle scripts stay off; node-pty is the one dependency whose native module has to be built
stamp="node_modules/.vt420-term-lockfile"
built="node_modules/.vt420-term-node"
if [[ ! -f "$stamp" ]] || ! cmp -s package-lock.json "$stamp" || [[ "$(cat "$built" 2>/dev/null)" != "$node" ]]; then
	npm ci --omit=dev --ignore-scripts --no-audit --no-fund
	npm rebuild node-pty
	cp package-lock.json "$stamp"
	echo "$node" > "$built"
fi

mkdir -p "$BIN"
ln -sfn "$ROOT/bin/vt420-term" "$BIN/vt420-term"
ln -sfn "$ROOT/bin/zellij-vt420" "$BIN/zellij-vt420"
# the commands that moved to vt420, where they still point here
for command in vt420 vt420-probe vt420-demo vt420-animations vt420-setup; do
	if [[ "$(readlink "$BIN/$command" 2>/dev/null)" == "$ROOT/bin/$command" ]]; then rm "$BIN/$command"; fi
done
# for the Help key in a zellij session that was not started through zellij-vt420
ln -sfn "$ROOT/bin/zellij-vt420-help" "$BIN/zellij-vt420-help"
ln -sfn "$ROOT/install.sh" "$BIN/vt420-term-update"
echo "vt420-term $("$node" "$ROOT/src/main.ts" --version) from $ROOT at $(git log -1 --format='%h %s' 2>/dev/null || echo 'an unversioned copy')"
