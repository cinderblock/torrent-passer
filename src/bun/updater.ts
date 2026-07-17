import { Updater } from "electrobun/bun";
import type { UpdateStatus } from "./rpc";

// Thin adapter over Electrobun's Updater: tracks a single UpdateStatus,
// notifies the view on change, and maps the updater's fine-grained status
// stream down to the handful of phases the UI cares about.

let status: UpdateStatus = {
	supported: false,
	currentVersion: "",
	updateAvailable: false,
	phase: "idle",
};

let notify: (s: UpdateStatus) => void = () => {};

export function getUpdateStatus(): UpdateStatus {
	return status;
}

export function onUpdateStatus(cb: (s: UpdateStatus) => void): void {
	notify = cb;
}

function set(patch: Partial<UpdateStatus>): void {
	status = { ...status, ...patch };
	notify(status);
}

// Map the updater's granular status stream onto our coarse phases. We only
// surface download progress and terminal errors; the rest is internal detail.
Updater.onStatusChange((entry) => {
	switch (entry.status) {
		case "download-progress":
		case "downloading":
		case "downloading-patch":
		case "downloading-full-bundle":
		case "decompressing":
		case "applying-patch":
			set({
				phase: "downloading",
				...(entry.details?.progress !== undefined
					? { progress: entry.details.progress }
					: {}),
				detail: entry.message,
			});
			break;
		case "error":
			set({ phase: "error", detail: entry.details?.errorMessage ?? entry.message });
			break;
		default:
			// checking / patch-found / extracting / replacing-app / launching etc.
			// are folded into the phase set by the calling function.
			break;
	}
});

export async function initUpdateStatus(): Promise<UpdateStatus> {
	try {
		const local = await Updater.getLocalInfo();
		const supported = local.channel !== "dev" && !!local.baseUrl;
		set({
			supported,
			currentVersion: local.version || "",
			phase: "idle",
		});
	} catch (err) {
		set({ phase: "error", detail: (err as Error).message });
	}
	return status;
}

export async function checkForUpdate(): Promise<UpdateStatus> {
	if (!status.supported) return status;
	set({ phase: "checking", detail: undefined });
	try {
		const result = await Updater.checkForUpdate();
		if (result.error) {
			set({ phase: "error", detail: result.error });
		} else if (result.updateAvailable) {
			set({
				phase: "available",
				updateAvailable: true,
				latestVersion: result.version || undefined,
				detail: undefined,
			});
		} else {
			set({ phase: "idle", updateAvailable: false, detail: undefined });
		}
	} catch (err) {
		set({ phase: "error", detail: (err as Error).message });
	}
	return status;
}

// Downloads the update and installs it. On success the process quits and
// relaunches into the new version (applyUpdate never returns normally), so a
// resolved result here means something went wrong before the hand-off.
export async function installUpdate(): Promise<{ ok: boolean; error?: string }> {
	if (!status.supported) return { ok: false, error: "Updates not supported on this build" };
	try {
		set({ phase: "downloading", progress: undefined, detail: "Starting download…" });
		await Updater.downloadUpdate();
		const info = Updater.updateInfo();
		if (!info?.updateReady) {
			const error = info?.error || "Download did not complete";
			set({ phase: "error", detail: error });
			return { ok: false, error };
		}
		set({ phase: "installing", detail: "Installing…" });
		await Updater.applyUpdate(); // quits + relaunches on success
		// If we're still here, the hand-off didn't take.
		return { ok: false, error: "Update prepared but the app did not relaunch" };
	} catch (err) {
		const error = (err as Error).message;
		set({ phase: "error", detail: error });
		return { ok: false, error };
	}
}
