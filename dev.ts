/**
 * Runs pi with this checkout loaded through `--extension`, and moves an installed
 * copy of the same package aside for the run so it is not loaded twice.
 *
 * ~/.pi/agent/settings.json is never touched: it is often a symlink into a dotfiles
 * repo, so editing it turns a dev run into a tracked-config change.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function packageRoot(): string {
	let dir = import.meta.dirname;
	while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
	return dir;
}

const root = packageRoot();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
	name: string;
	pi?: { extensions?: string[] };
};
const entry = pkg.pi?.extensions?.[0];
if (!entry) throw new Error("package.json has no pi.extensions entry");

const installed = join(
	homedir(),
	".pi",
	"agent",
	"npm",
	"node_modules",
	pkg.name,
);
const stashed = `${installed}.dev-stash`;

if (existsSync(stashed)) {
	console.error(`stale ${stashed} — restore it first`);
	process.exit(1);
}

const restore = () => {
	if (existsSync(stashed)) renameSync(stashed, installed);
};

if (existsSync(installed)) renameSync(installed, stashed);
process.on("SIGINT", restore);
process.on("SIGTERM", restore);

try {
	const { status } = spawnSync(
		"pi",
		["--extension", resolve(root, entry), ...process.argv.slice(2)],
		{ stdio: "inherit" },
	);
	process.exitCode = status ?? 1;
} finally {
	restore();
}
