import type { DelugeWebDestination, PreflightStatus, UploadResult } from "../rpc";
import type { DestinationDriver, UploadContext } from "./types";

function log(
	dest: DelugeWebDestination,
	level: "log" | "error",
	...args: unknown[]
): void {
	const tag = `[deluge-web ${dest.name} ${dest.url}]`;
	if (level === "error") console.error(tag, ...args);
	else console.log(tag, ...args);
}

// Per-destination cookie cache so repeated uploads inside one session don't
// re-auth every time. Cleared if the server returns an auth-failed response.
const sessionCookies = new Map<string, string>();

interface JsonRpcResponse<T> {
	result: T;
	error: { message: string; code?: number } | null;
	id: number;
}

let nextRpcId = 1;

async function jsonRpc<T>(
	dest: DelugeWebDestination,
	method: string,
	params: unknown[],
	signal?: AbortSignal,
): Promise<T> {
	const id = nextRpcId++;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json",
	};
	const cookie = sessionCookies.get(dest.id);
	if (cookie) headers["Cookie"] = cookie;

	const res = await fetch(joinUrl(dest.url, "/json"), {
		method: "POST",
		headers,
		body: JSON.stringify({ method, params, id }),
		signal,
		tls: dest.insecure ? { rejectUnauthorized: false } : undefined,
	});

	const setCookie = res.headers.get("set-cookie");
	if (setCookie) {
		const sid = /_session_id=[^;]+/.exec(setCookie)?.[0];
		if (sid) sessionCookies.set(dest.id, sid);
	}

	if (!res.ok) {
		throw new Error(`HTTP ${res.status} ${res.statusText}`);
	}
	const data = (await res.json()) as JsonRpcResponse<T>;
	if (data.error) {
		throw new Error(data.error.message);
	}
	return data.result;
}

async function ensureLoggedIn(
	dest: DelugeWebDestination,
	signal?: AbortSignal,
): Promise<void> {
	if (sessionCookies.has(dest.id)) {
		try {
			const connected = await jsonRpc<boolean>(
				dest,
				"web.connected",
				[],
				signal,
			);
			if (connected) return;
		} catch {
			// fall through and re-auth
		}
		sessionCookies.delete(dest.id);
	}
	const ok = await jsonRpc<boolean>(
		dest,
		"auth.login",
		[dest.password],
		signal,
	);
	if (!ok) throw new Error("Deluge login failed: bad password?");
}

export const delugeWebDriver: DestinationDriver<DelugeWebDestination> = {
	async preflight(dest, signal) {
		try {
			await ensureLoggedIn(dest, signal);
			const connected = await jsonRpc<boolean>(
				dest,
				"web.connected",
				[],
				signal,
			);
			let version: string | undefined;
			let defaultDir: string | undefined;
			if (connected) {
				try {
					version = await jsonRpc<string>(dest, "daemon.info", [], signal);
				} catch {
					// daemon.info isn't fatal — keep the destination usable.
				}
				try {
					const dir = await jsonRpc<string>(
						dest,
						"core.get_config_value",
						["download_location"],
						signal,
					);
					if (typeof dir === "string") defaultDir = dir;
				} catch {
					// Non-fatal.
				}
			}
			const status: PreflightStatus = {
				destinationId: dest.id,
				ok: connected,
				detail: connected
					? version
						? `daemon ${version}`
						: "connected"
					: "WebUI not connected to daemon",
			};
			if (version) status.version = version;
			if (defaultDir) status.defaultDownloadLocation = defaultDir;
			return status;
		} catch (err: unknown) {
			return {
				destinationId: dest.id,
				ok: false,
				detail: (err as Error).message,
			};
		}
	},

	async upload(dest, ctx) {
		log(dest, "log", `upload start filename=${ctx.filename} bytes=${ctx.bytes.byteLength}`);
		const start = performance.now();
		try {
			await ensureLoggedIn(dest);
			log(dest, "log", "login ok, uploading file body");
			const uploadedPath = await uploadFile(dest, ctx);
			log(dest, "log", `server stored upload at ${uploadedPath}`);
			const options: Record<string, unknown> = {};
			if (dest.downloadLocation) {
				options["download_location"] = dest.downloadLocation;
			}
			if (dest.addPaused !== undefined) {
				options["add_paused"] = dest.addPaused;
			}
			log(dest, "log", `web.add_torrents options=${JSON.stringify(options)}`);
			const added = await jsonRpc<Array<[boolean, string]>>(
				dest,
				"web.add_torrents",
				[[{ path: uploadedPath, options }]],
			);
			const ms = (performance.now() - start).toFixed(0);
			const first = added[0];
			if (first && first[0] === false) {
				log(dest, "error", `add_torrents rejected: ${first[1]}`);
				return {
					ok: false,
					error: `Deluge rejected torrent: ${first[1] ?? "unknown"}`,
				};
			}
			log(dest, "log", `add_torrents ok in ${ms}ms`);
			return { ok: true, message: "Added to Deluge" };
		} catch (err: unknown) {
			const msg = (err as Error).message;
			if (/already in session/i.test(msg)) {
				log(dest, "log", "torrent already in session — treating as success");
				return { ok: true, message: "Already in Deluge" };
			}
			log(dest, "error", `upload failed: ${msg}`);
			return { ok: false, error: prettifyDelugeWebError(msg) };
		}
	},
};

function prettifyDelugeWebError(msg: string): string {
	let out = msg.replace(/^Deluge rejected torrent:\s*/i, "");
	out = out.replace(/\s*\([0-9a-f]{40}\)\.?$/i, "");
	out = out.replace(/^[A-Z][A-Za-z]*Error:\s*/, "");
	return out.trim() || msg;
}

async function uploadFile(
	dest: DelugeWebDestination,
	ctx: UploadContext,
): Promise<string> {
	const form = new FormData();
	form.append(
		"file",
		new Blob([ctx.bytes], { type: "application/x-bittorrent" }),
		ctx.filename,
	);
	const headers: Record<string, string> = {};
	const cookie = sessionCookies.get(dest.id);
	if (cookie) headers["Cookie"] = cookie;

	const res = await fetch(joinUrl(dest.url, "/upload"), {
		method: "POST",
		headers,
		body: form,
		tls: dest.insecure ? { rejectUnauthorized: false } : undefined,
	});
	if (!res.ok) throw new Error(`Upload HTTP ${res.status}`);
	const data = (await res.json()) as { success?: boolean; files?: string[] };
	const path = data.files?.[0];
	if (!path) throw new Error("Deluge upload returned no file path");
	return path;
}

function joinUrl(base: string, path: string): string {
	const b = base.endsWith("/") ? base.slice(0, -1) : base;
	const p = path.startsWith("/") ? path : `/${path}`;
	return `${b}${p}`;
}

export function preflightStatus(
	destinationId: string,
	ok: boolean,
	detail?: string,
): PreflightStatus {
	return detail !== undefined ? { destinationId, ok, detail } : { destinationId, ok };
}

export type { UploadResult };
