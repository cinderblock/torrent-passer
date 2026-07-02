import Electrobun, {
	BrowserWindow,
	defineElectrobunRPC,
	Utils,
} from "electrobun/bun";
import { loadConfig, saveConfig } from "./config";
import { preflightDestination, uploadToDestination } from "./destinations";
import {
	getFileAssociationStatus,
	installFileAssociation,
	uninstallFileAssociation,
} from "./file-association";
import type {
	AppRPC,
	Config,
	FileAssociationStatus,
	InitialState,
	PreflightStatus,
	TorrentInfo,
} from "./rpc";
import type { LoadedTorrent } from "./torrent";
import { getLinuxParentArgs } from "./linux-parent-cmdline";
import { readTorrent, resolveTorrentArg } from "./torrent";
import { getWindowsParentArgs } from "./win-parent-cmdline";

// ---- Mutable state holders -------------------------------------------------

const state = {
	torrentPath: null as string | null,
	torrentPromise: Promise.resolve<LoadedTorrent | null>(null),
	configPromise: Promise.resolve<Config>({ destinations: [] }),
	preflightResults: new Map<string, PreflightStatus>(),
	preflightAbort: new AbortController(),
	fileAssociationPromise: getFileAssociationStatus(),
};

const startedAt = performance.now();

// ---- Late-bound callbacks (defined after windows exist) --------------------

let pushPreflight: (status: PreflightStatus) => void = () => {};
let pushConfigChanged: (config: Config) => void = () => {};
let pushFileAssociation: (status: FileAssociationStatus) => void = () => {};
let pushTorrentChanged: (torrent: TorrentInfo | null) => void = () => {};
let closeMainWindow: () => void = () => {};

// ---- Kick off parallel work ASAP -------------------------------------------

function ingestTorrent(path: string): void {
	state.torrentPath = path;
	state.torrentPromise = readTorrent(path).catch((err) => {
		console.error("[torrent-passer] failed to read torrent:", err);
		return null;
	});
	void state.torrentPromise.then((t) => pushTorrentChanged(t?.info ?? null));
}

let initialArg = resolveTorrentArg(process.argv.slice(2));
// On Windows and Linux the launcher swallows the file-association arg before
// bun runs (blackboardsh/electrobun#483), but it survives in the launcher
// (parent) process's command line. Recover it from there when our own argv
// came up empty. macOS delivers file opens via the open-url event instead.
if (!initialArg) {
	const parentArgs =
		process.platform === "win32"
			? getWindowsParentArgs()
			: process.platform === "linux"
				? getLinuxParentArgs()
				: [];
	const fromParent = resolveTorrentArg(parentArgs);
	if (fromParent) {
		console.log(`[torrent-passer] recovered torrent from parent cmdline: ${fromParent}`);
		initialArg = fromParent;
	}
}
if (initialArg) ingestTorrent(initialArg);

Electrobun.events.on("open-url", (e: { data: { url: string } }) => {
	const incoming = resolveTorrentArg([e.data.url]);
	if (!incoming) return;
	ingestTorrent(incoming);
});

state.configPromise = loadConfig();

function restartPreflight(config: Config): void {
	state.preflightAbort.abort();
	const controller = new AbortController();
	state.preflightAbort = controller;
	state.preflightResults.clear();
	if (config.destinations.length === 0) return;
	for (const d of config.destinations) {
		void preflightDestination(d, controller.signal).then((status) => {
			if (controller.signal.aborted) return;
			state.preflightResults.set(status.destinationId, status);
			pushPreflight(status);
		});
	}
}

void state.configPromise.then((cfg) => restartPreflight(cfg));

// ---- RPC -------------------------------------------------------------------

const rpc = defineElectrobunRPC<AppRPC, "bun">("bun", {
	handlers: {
		requests: {
			async getInitialState(): Promise<InitialState> {
				// Resolve the things we need to render. Preflight is NOT awaited —
				// results stream in via preflightUpdate messages so a slow Deluge
				// can't gate the picker UI.
				const [config, torrent, fileAssociation] = await Promise.all([
					state.configPromise,
					state.torrentPromise,
					state.fileAssociationPromise,
				]);
				console.log(
					`[torrent-passer] initialState ready at +${(
						performance.now() - startedAt
					).toFixed(1)}ms`,
				);
				return {
					torrent: torrent?.info ?? null,
					config,
					preflight: Array.from(state.preflightResults.values()),
					fileAssociation,
				};
			},
			async upload({ destinationId }) {
				const config = await state.configPromise;
				const dest = config.destinations.find((d) => d.id === destinationId);
				if (!dest) return { ok: false, error: "Destination not found" };
				const torrent = await state.torrentPromise;
				if (!torrent) return { ok: false, error: "No torrent file loaded" };
				const result = await uploadToDestination(dest, {
					bytes: torrent.bytes,
					filename: torrent.info.filename,
					...(torrent.info.name !== undefined
						? { torrentName: torrent.info.name }
						: {}),
				});
				if (result.ok && config.lastUsedId !== destinationId) {
					const next: Config = { ...config, lastUsedId: destinationId };
					state.configPromise = Promise.resolve(next);
					void saveConfig(next).catch((err) =>
						console.error("[torrent-passer] saveConfig failed:", err),
					);
				}
				return result;
			},
			async closeWindow() {
				closeMainWindow();
			},
			async getConfig() {
				return state.configPromise;
			},
			async saveConfig({ config }: { config: Config }) {
				await saveConfig(config);
				state.configPromise = Promise.resolve(config);
				restartPreflight(config);
				pushConfigChanged(config);
			},
			async installFileAssociation(): Promise<FileAssociationStatus> {
				const status = await installFileAssociation();
				state.fileAssociationPromise = Promise.resolve(status);
				pushFileAssociation(status);
				return status;
			},
			async uninstallFileAssociation(): Promise<FileAssociationStatus> {
				const status = await uninstallFileAssociation();
				state.fileAssociationPromise = Promise.resolve(status);
				pushFileAssociation(status);
				return status;
			},
			async pickTorrent(): Promise<TorrentInfo | null> {
				const picked = await Utils.openFileDialog({
					allowedFileTypes: "torrent",
					canChooseFiles: true,
					canChooseDirectory: false,
					allowsMultipleSelection: false,
				});
				const path = picked.find((p) => p && p.toLowerCase().endsWith(".torrent"));
				if (!path) return null;
				ingestTorrent(path);
				const loaded = await state.torrentPromise;
				return loaded?.info ?? null;
			},
			async logToBun({ msg }: { msg: string }) {
				console.log(`[view] ${msg}`);
			},
		},
	},
});

// ---- Windows ---------------------------------------------------------------

const mainWindow = new BrowserWindow<typeof rpc>({
	title: "torrent-passer",
	url: "views://mainview/index.html",
	frame: { width: 600, height: 780, x: 200, y: 200 },
	rpc,
});

pushPreflight = (status) =>
	mainWindow.webview.rpc?.send.preflightUpdate({ status });
pushConfigChanged = (config) =>
	mainWindow.webview.rpc?.send.configChanged({ config });
pushFileAssociation = (status) =>
	mainWindow.webview.rpc?.send.fileAssociationChanged({ status });
pushTorrentChanged = (torrent) =>
	mainWindow.webview.rpc?.send.torrentChanged({ torrent });
closeMainWindow = () => mainWindow.close();

console.log(
	`[torrent-passer] bun process up at +${(
		performance.now() - startedAt
	).toFixed(1)}ms (torrent: ${initialArg ?? "<none>"})`,
);
