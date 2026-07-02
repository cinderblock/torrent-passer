import { spawn, type SpawnOptions } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { FileAssociationStatus } from "./rpc";

const PROG_ID = "torrent-passer.File";
const REG_BASE = "HKCU\\Software\\Classes";
const DESKTOP_ID = "torrent-passer.desktop";
const MIME_TYPE = "application/x-bittorrent";

function launcherPath(): string {
	// process.execPath is bun[.exe] (under <bundle>/bin/). The launcher
	// sibling is the actual file the OS should be told to invoke for
	// double-clicks.
	const name = process.platform === "win32" ? "launcher.exe" : "launcher";
	return join(dirname(process.execPath), name);
}

function isDevBuild(): boolean {
	// Dev builds live at .../build/dev-<arch>/<app>/bin/bun[.exe] — the
	// "/build/dev-" segment is the reliable marker. Stable installs
	// land in Program Files / %LOCALAPPDATA%\Programs and don't have it.
	const p = process.execPath;
	return p.includes(`${sep}build${sep}dev-`);
}

async function execCapture(
	command: string,
	args: string[],
	options: SpawnOptions = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: "pipe", ...options });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (b: Buffer) => {
			stdout += b.toString();
		});
		child.stderr?.on("data", (b: Buffer) => {
			stderr += b.toString();
		});
		child.on("error", (err) => {
			resolve({ ok: false, stdout, stderr: stderr + err.message, code: null });
		});
		child.on("close", (code) => {
			resolve({ ok: code === 0, stdout, stderr, code });
		});
	});
}

async function regQuery(path: string): Promise<string | null> {
	const res = await execCapture("reg.exe", ["query", path, "/ve"]);
	if (!res.ok) return null;
	const match = /\(Default\)\s+REG_SZ\s+(.+)/.exec(res.stdout);
	return match?.[1]?.trim() ?? null;
}

async function regAdd(path: string, value: string): Promise<boolean> {
	const res = await execCapture("reg.exe", [
		"add",
		path,
		"/ve",
		"/d",
		value,
		"/f",
	]);
	return res.ok;
}

async function regDelete(path: string): Promise<boolean> {
	const res = await execCapture("reg.exe", ["delete", path, "/f"]);
	return res.ok;
}

async function getWindowsStatus(): Promise<FileAssociationStatus> {
	const expected = launcherPath();
	const dev = isDevBuild();
	const handler = await regQuery(`${REG_BASE}\\.torrent`);
	if (handler !== PROG_ID) {
		return {
			platform: "win32",
			supported: !dev,
			installed: false,
			detail: dev
				? "Dev build — install a release before registering this"
				: handler
					? `.torrent currently handled by ${handler}`
					: "No association registered",
		};
	}
	const command = await regQuery(`${REG_BASE}\\${PROG_ID}\\shell\\open\\command`);
	if (!command || !command.includes(expected)) {
		return {
			platform: "win32",
			supported: !dev,
			installed: false,
			detail: dev
				? "Dev build — install a release before registering this"
				: command
					? `Association points elsewhere: ${command}`
					: "Command key missing",
		};
	}
	return {
		platform: "win32",
		supported: !dev,
		installed: true,
		detail: dev ? `${expected} (dev build path)` : expected,
	};
}

async function installWindows(): Promise<FileAssociationStatus> {
	const exe = launcherPath();
	const cmd = `"${exe}" "%1"`;
	const ok =
		(await regAdd(`${REG_BASE}\\.torrent`, PROG_ID)) &&
		(await regAdd(`${REG_BASE}\\${PROG_ID}`, "BitTorrent file")) &&
		(await regAdd(`${REG_BASE}\\${PROG_ID}\\shell\\open\\command`, cmd));
	if (!ok) {
		return {
			platform: "win32",
			supported: true,
			installed: false,
			detail: "reg.exe add failed — check the console output",
		};
	}
	notifyShellChange();
	return getWindowsStatus();
}

async function uninstallWindows(): Promise<FileAssociationStatus> {
	await regDelete(`${REG_BASE}\\.torrent`);
	await regDelete(`${REG_BASE}\\${PROG_ID}`);
	notifyShellChange();
	return getWindowsStatus();
}

function notifyShellChange(): void {
	// Nudge Explorer to pick up new file associations without a reboot.
	void execCapture("rundll32.exe", [
		"shell32.dll,SHChangeNotify",
		"0x08000000",
		"0x0000",
		"0",
		"0",
	]);
}

// ---- Linux: user-scope .desktop entry + xdg-mime default ------------------

function linuxApplicationsDir(): string {
	const dataHome =
		process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share");
	return join(dataHome, "applications");
}

async function getLinuxStatus(): Promise<FileAssociationStatus> {
	const dev = isDevBuild();
	const expected = launcherPath();
	const desktopFile = join(linuxApplicationsDir(), DESKTOP_ID);
	let exec: string | null = null;
	try {
		const content = await readFile(desktopFile, "utf8");
		exec = /^Exec=(.+)$/m.exec(content)?.[1]?.trim() ?? null;
	} catch {
		// No desktop file — not installed.
	}
	if (!exec || !exec.includes(expected)) {
		return {
			platform: "linux",
			supported: !dev,
			installed: false,
			detail: dev
				? "Dev build — install a release before registering this"
				: exec
					? `Desktop entry points elsewhere: ${exec}`
					: "No association registered",
		};
	}
	const q = await execCapture("xdg-mime", ["query", "default", MIME_TYPE]);
	const current = q.stdout.trim();
	if (!q.ok || current !== DESKTOP_ID) {
		return {
			platform: "linux",
			supported: !dev,
			installed: false,
			detail: current
				? `.torrent currently handled by ${current}`
				: "Desktop entry exists but is not the xdg-mime default",
		};
	}
	return {
		platform: "linux",
		supported: !dev,
		installed: true,
		detail: dev ? `${expected} (dev build path)` : expected,
	};
}

async function installLinux(): Promise<FileAssociationStatus> {
	const exe = launcherPath();
	const dir = linuxApplicationsDir();
	const content = `[Desktop Entry]
Version=1.0
Type=Application
Name=torrent-passer
Comment=Forward .torrent files to a configurable destination
Exec="${exe}" %f
Terminal=false
MimeType=${MIME_TYPE};
Categories=Utility;Network;
`;
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, DESKTOP_ID), content);
	} catch (err) {
		return {
			platform: "linux",
			supported: true,
			installed: false,
			detail: `Failed to write ${join(dir, DESKTOP_ID)}: ${err}`,
		};
	}
	const ok = (await execCapture("xdg-mime", ["default", DESKTOP_ID, MIME_TYPE]))
		.ok;
	// Best-effort cache refresh; older desktops pick the entry up without it.
	void execCapture("update-desktop-database", [dir]);
	if (!ok) {
		return {
			platform: "linux",
			supported: true,
			installed: false,
			detail: "xdg-mime default failed — is xdg-utils installed?",
		};
	}
	return getLinuxStatus();
}

async function uninstallLinux(): Promise<FileAssociationStatus> {
	const dir = linuxApplicationsDir();
	await rm(join(dir, DESKTOP_ID), { force: true });
	void execCapture("update-desktop-database", [dir]);
	return getLinuxStatus();
}

// ---- Platform dispatch ------------------------------------------------------

export async function getFileAssociationStatus(): Promise<FileAssociationStatus> {
	if (process.platform === "win32") return getWindowsStatus();
	if (process.platform === "linux") return getLinuxStatus();
	if (process.platform === "darwin") {
		return {
			platform: "darwin",
			supported: false,
			installed: true,
			detail: "macOS handles .torrent via the bundled Info.plist",
		};
	}
	return {
		platform: process.platform,
		supported: false,
		installed: false,
		detail: "Manual setup required on this platform",
	};
}

export async function installFileAssociation(): Promise<FileAssociationStatus> {
	if (process.platform === "win32") return installWindows();
	if (process.platform === "linux") return installLinux();
	return getFileAssociationStatus();
}

export async function uninstallFileAssociation(): Promise<FileAssociationStatus> {
	if (process.platform === "win32") return uninstallWindows();
	if (process.platform === "linux") return uninstallLinux();
	return getFileAssociationStatus();
}
