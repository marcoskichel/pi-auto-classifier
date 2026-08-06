#!/bin/sh
# ponytail: symlink swap, no watcher — pi loads index.ts from source, so a pi
# restart is the reload. Add a watcher only if pi ever gains hot reload.
set -e
target="$HOME/.pi/agent/npm/node_modules/$(node -p 'require("./package.json").name')"
[ -e "$target.bak" ] && {
	echo "stale $target.bak — restore it first" >&2
	exit 1
}
[ -e "$target" ] && mv "$target" "$target.bak"
ln -s "$PWD" "$target"
restore() {
	[ -L "$target" ] || return 0
	rm -f "$target"
	[ -e "$target.bak" ] && mv "$target.bak" "$target"
	echo "restored"
}
trap restore EXIT INT TERM
echo "linked $PWD -> $target"
echo "restart pi to pick up edits; ctrl-c here to unlink"
while :; do sleep 3600; done
