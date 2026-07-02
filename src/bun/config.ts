import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "./rpc";

function configDir(): string {
	if (process.platform === "win32") {
		const appData = process.env["APPDATA"];
		if (appData) return join(appData, "torrent-passer");
	}
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Application Support", "torrent-passer");
	}
	const xdg = process.env["XDG_CONFIG_HOME"];
	return join(xdg ?? join(homedir(), ".config"), "torrent-passer");
}

export const CONFIG_PATH = join(configDir(), "config.json");

const EMPTY_CONFIG: Config = { destinations: [] };

// Dedupe destinations by id, keeping the first occurrence. Heals configs
// that may have grown duplicate entries from earlier UI bugs.
function dedupe(config: Config): Config {
	const seen = new Set<string>();
	const destinations = [];
	let droppedAny = false;
	for (const d of config.destinations) {
		if (!d || typeof d.id !== "string") continue;
		if (seen.has(d.id)) {
			droppedAny = true;
			continue;
		}
		seen.add(d.id);
		destinations.push(d);
	}
	if (!droppedAny && destinations.length === config.destinations.length) {
		return config;
	}
	console.warn(
		`[torrent-passer] dropped ${
			config.destinations.length - destinations.length
		} duplicate destination(s)`,
	);
	return { ...config, destinations };
}

export async function loadConfig(): Promise<Config> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as Config;
		if (!parsed || !Array.isArray(parsed.destinations)) return EMPTY_CONFIG;
		return dedupe(parsed);
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") return EMPTY_CONFIG;
		console.error("[torrent-passer] failed to read config:", err);
		return EMPTY_CONFIG;
	}
}

export async function saveConfig(config: Config): Promise<void> {
	const clean = dedupe(config);
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(clean, null, 2), "utf8");
	await rename(tmp, CONFIG_PATH);
}
