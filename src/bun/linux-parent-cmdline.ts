import { readFileSync } from "node:fs";

// Electrobun's launcher drops its argv on Linux too — same bug as Windows
// (blackboardsh/electrobun#483): it spawns `bun main.js` with a hard-coded
// two-element argv. The launcher stays alive as our parent process, so the
// file path from a `.desktop` `Exec=launcher %f` invocation is still
// readable from /proc/<ppid>/cmdline (NUL-separated).
export function getLinuxParentArgs(): string[] {
	if (process.platform !== "linux") return [];
	try {
		const raw = readFileSync(`/proc/${process.ppid}/cmdline`, "utf8");
		return raw.split("\0").filter(Boolean).slice(1); // drop exe path
	} catch (err) {
		console.error("[torrent-passer] /proc parent cmdline read failed:", err);
		return [];
	}
}
