#!/usr/bin/env bash
# Install or update vt420-term from this checkout: the dependencies, node-pty's native module, and the commands
# vt420-term and zellij-vt420 in ~/.local/bin. Linked as vt420-term-update.
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

# lifecycle scripts stay off; node-pty is the one dependency whose native module has to be built
stamp="node_modules/.vt420-term-lockfile"
if [[ ! -f "$stamp" ]] || ! cmp -s package-lock.json "$stamp"; then
	npm ci --omit=dev --ignore-scripts --no-audit --no-fund
	npm rebuild node-pty
	cp package-lock.json "$stamp"
fi

mkdir -p "$BIN"
ln -sfn "$ROOT/bin/vt420-term" "$BIN/vt420-term"
ln -sfn "$ROOT/bin/zellij-vt420" "$BIN/zellij-vt420"
# for the Help key in a zellij session that was not started through zellij-vt420
ln -sfn "$ROOT/bin/zellij-vt420-help" "$BIN/zellij-vt420-help"
ln -sfn "$ROOT/install.sh" "$BIN/vt420-term-update"
echo "vt420-term $(node "$ROOT/src/main.ts" --version) from $ROOT at $(git log -1 --format='%h %s' 2>/dev/null || echo 'an unversioned copy')"
