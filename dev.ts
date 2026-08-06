import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SETTINGS = path.join(os.homedir(), ".pi", "agent", "settings.json");
const BACKUP = `${SETTINGS}.dev-backup`;
const PACKAGE = "npm:pi-auto-classifier";
const ENTRY = path.resolve(import.meta.dirname, "index.ts");

type Settings = { packages?: string[]; extensions?: string[] };

function read(file: string): Settings {
	return JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
}

function write(settings: Settings): void {
	fs.writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
}

if (process.argv.includes("--off")) {
	write(read(BACKUP));
	fs.unlinkSync(BACKUP);
	console.log(`restored ${SETTINGS}`);
} else {
	if (!fs.existsSync(BACKUP)) {
		fs.copyFileSync(SETTINGS, BACKUP);
	}
	const settings = read(BACKUP);
	settings.packages = (settings.packages ?? []).filter(
		(name) => name !== PACKAGE,
	);
	settings.extensions = [
		...(settings.extensions ?? []).filter(
			(entry) => !entry.endsWith("index.ts"),
		),
		ENTRY,
	];
	write(settings);
	console.log(`loaded ${ENTRY}\nrun "npm run dev -- --off" to restore`);
}
