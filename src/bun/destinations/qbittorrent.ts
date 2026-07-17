import type { PreflightStatus, QbittorrentDestination } from "../rpc";
import type { DestinationDriver, UploadContext } from "./types";
import { joinUrl } from "./util";

function log(
	dest: QbittorrentDestination,
	level: "log" | "error",
	...args: unknown[]
): void {
	const tag = `[qbittorrent ${dest.name} ${dest.url}]`;
	if (level === "error") console.error(tag, ...args);
	else console.log(tag, ...args);
}

// Per-destination SID cookie cache so repeated uploads inside one session
// don't re-auth every time. Cleared when the server answers 403.
const sessionCookies = new Map<string, string>();

function tlsFor(dest: QbittorrentDestination) {
	return dest.insecure ? { rejectUnauthorized: false } : undefined;
}

async function api(
	dest: QbittorrentDestination,
	path: string,
	init: RequestInit = {},
	signal?: AbortSignal,
): Promise<Response> {
	const headers: Record<string, string> = {
		...(init.headers as Record<string, string> | undefined),
	};
	const sid = sessionCookies.get(dest.id);
	if (sid) headers["Cookie"] = sid;
	return fetch(joinUrl(dest.url, path), {
		...init,
		headers,
		signal,
		tls: tlsFor(dest),
	});
}

async function login(
	dest: QbittorrentDestination,
	signal?: AbortSignal,
): Promise<void> {
	// No username configured → rely on qBittorrent's "bypass authentication
	// for localhost/whitelisted IPs" setting; there is nothing to log in with.
	if (!dest.username) return;
	const body = new URLSearchParams({
		username: dest.username,
		password: dest.password ?? "",
	});
	const res = await fetch(joinUrl(dest.url, "/api/v2/auth/login"), {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
		signal,
		tls: tlsFor(dest),
	});
	const text = (await res.text().catch(() => "")).trim();
	if (res.status === 403) {
		throw new Error("Login refused (IP banned after failed attempts?)");
	}
	if (!res.ok || text !== "Ok.") {
		throw new Error("qBittorrent login failed: bad username/password?");
	}
	const setCookie = res.headers.get("set-cookie");
	const sid = setCookie ? /SID=[^;]+/.exec(setCookie)?.[0] : undefined;
	if (!sid) throw new Error("qBittorrent login returned no SID cookie");
	sessionCookies.set(dest.id, sid);
}

async function withAuth(
	dest: QbittorrentDestination,
	fn: () => Promise<Response>,
	signal?: AbortSignal,
): Promise<Response> {
	if (!sessionCookies.has(dest.id)) await login(dest, signal);
	let res = await fn();
	if (res.status === 403 && dest.username) {
		// Stale SID — re-auth once and retry.
		sessionCookies.delete(dest.id);
		await login(dest, signal);
		res = await fn();
	}
	return res;
}

export const qbittorrentDriver: DestinationDriver<QbittorrentDestination> = {
	async preflight(dest, signal) {
		try {
			const res = await withAuth(
				dest,
				() => api(dest, "/api/v2/app/version", {}, signal),
				signal,
			);
			if (res.status === 403) {
				return {
					destinationId: dest.id,
					ok: false,
					detail:
						"Authentication required — set a username/password or enable localhost bypass",
				};
			}
			if (!res.ok) {
				return {
					destinationId: dest.id,
					ok: false,
					detail: `HTTP ${res.status} ${res.statusText}`,
				};
			}
			const version = (await res.text()).trim().replace(/^v/, "");
			const status: PreflightStatus = {
				destinationId: dest.id,
				ok: true,
				detail: version ? `qBittorrent ${version}` : "connected",
			};
			if (version) status.version = version;
			try {
				const prefRes = await api(dest, "/api/v2/app/preferences", {}, signal);
				if (prefRes.ok) {
					const prefs = (await prefRes.json()) as { save_path?: string };
					if (prefs.save_path) {
						status.defaultDownloadLocation = prefs.save_path;
					}
				}
			} catch {
				// Non-fatal — default save path is a nice-to-have.
			}
			return status;
		} catch (err: unknown) {
			return {
				destinationId: dest.id,
				ok: false,
				detail: (err as Error).message,
			};
		}
	},

	async upload(dest, ctx: UploadContext) {
		log(dest, "log", `upload start filename=${ctx.filename} bytes=${ctx.bytes.byteLength}`);
		const start = performance.now();
		try {
			const buildForm = () => {
				const form = new FormData();
				form.append(
					"torrents",
					new Blob([ctx.bytes], { type: "application/x-bittorrent" }),
					ctx.filename,
				);
				if (dest.downloadLocation) form.append("savepath", dest.downloadLocation);
				if (dest.category) form.append("category", dest.category);
				if (dest.addPaused !== undefined) {
					const v = dest.addPaused ? "true" : "false";
					form.append("paused", v); // qBittorrent ≤ 4.x
					form.append("stopped", v); // qBittorrent 5.x renamed the flag
				}
				return form;
			};
			const res = await withAuth(dest, () =>
				api(dest, "/api/v2/torrents/add", { method: "POST", body: buildForm() }),
			);
			const ms = (performance.now() - start).toFixed(0);
			const body = (await res.text().catch(() => "")).trim();
			if (res.status === 415) {
				log(dest, "error", `rejected as invalid torrent in ${ms}ms`);
				return { ok: false, error: "qBittorrent rejected the file as not a valid torrent" };
			}
			if (!res.ok) {
				log(dest, "error", `upload failed in ${ms}ms HTTP ${res.status} ${body.slice(0, 200)}`);
				return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
			}
			if (body === "Fails.") {
				// qBittorrent answers 200 "Fails." for duplicates and add errors;
				// it doesn't distinguish, so surface it as-is.
				log(dest, "error", `add reported Fails. in ${ms}ms`);
				return { ok: false, error: "qBittorrent could not add the torrent (already added?)" };
			}
			log(dest, "log", `upload ok in ${ms}ms`);
			return { ok: true, message: "Added to qBittorrent" };
		} catch (err: unknown) {
			log(dest, "error", `upload threw: ${(err as Error).message}`);
			return { ok: false, error: (err as Error).message };
		}
	},
};
