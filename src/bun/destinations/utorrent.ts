import type { UtorrentDestination } from "../rpc";
import type { DestinationDriver, UploadContext } from "./types";
import { basicAuthHeaders } from "./util";

function log(
	dest: UtorrentDestination,
	level: "log" | "error",
	...args: unknown[]
): void {
	const tag = `[utorrent ${dest.name} ${dest.url}]`;
	if (level === "error") console.error(tag, ...args);
	else console.log(tag, ...args);
}

// The classic WebUI needs a CSRF token from /gui/token.html plus the GUID
// cookie that arrives with it. Cached per destination; refreshed on 400/401.
const sessions = new Map<string, { token: string; cookie?: string }>();

function guiUrl(dest: UtorrentDestination): string {
	const u = new URL(dest.url);
	const path = u.pathname.replace(/\/$/, "");
	u.pathname = path.endsWith("/gui") ? path : `${path}/gui`;
	return u.toString().replace(/\/$/, "");
}

function tlsFor(dest: UtorrentDestination) {
	return dest.insecure ? { rejectUnauthorized: false } : undefined;
}

async function fetchToken(
	dest: UtorrentDestination,
	signal?: AbortSignal,
): Promise<{ token: string; cookie?: string }> {
	const res = await fetch(`${guiUrl(dest)}/token.html`, {
		headers: basicAuthHeaders(dest.username, dest.password),
		signal,
		tls: tlsFor(dest),
	});
	if (res.status === 401) {
		throw new Error("Authentication failed: bad username/password?");
	}
	if (!res.ok) throw new Error(`token.html HTTP ${res.status}`);
	const html = await res.text();
	const token = />([^<>]+)<\/div>/.exec(html)?.[1];
	if (!token) throw new Error("Could not parse token from token.html");
	const setCookie = res.headers.get("set-cookie");
	const guid = setCookie ? /GUID=[^;]+/.exec(setCookie)?.[0] : undefined;
	const session = { token, ...(guid !== undefined ? { cookie: guid } : {}) };
	sessions.set(dest.id, session);
	return session;
}

async function addFile(
	dest: UtorrentDestination,
	ctx: UploadContext,
	session: { token: string; cookie?: string },
): Promise<Response> {
	const form = new FormData();
	form.append(
		"torrent_file",
		new Blob([ctx.bytes], { type: "application/x-bittorrent" }),
		ctx.filename,
	);
	const headers: Record<string, string> = basicAuthHeaders(
		dest.username,
		dest.password,
	);
	if (session.cookie) headers["Cookie"] = session.cookie;
	const url = `${guiUrl(dest)}/?token=${encodeURIComponent(session.token)}&action=add-file`;
	return fetch(url, {
		method: "POST",
		headers,
		body: form,
		tls: tlsFor(dest),
	});
}

export const utorrentDriver: DestinationDriver<UtorrentDestination> = {
	async preflight(dest, signal) {
		try {
			await fetchToken(dest, signal);
			return { destinationId: dest.id, ok: true, detail: "WebUI reachable" };
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
			let session = sessions.get(dest.id) ?? (await fetchToken(dest));
			let res = await addFile(dest, ctx, session);
			if (res.status === 400 || res.status === 401) {
				// Stale/invalid token — refresh once and retry.
				session = await fetchToken(dest);
				res = await addFile(dest, ctx, session);
			}
			const ms = (performance.now() - start).toFixed(0);
			const body = await res.text().catch(() => "");
			if (!res.ok) {
				log(dest, "error", `upload failed in ${ms}ms HTTP ${res.status}`);
				return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
			}
			let parsed: { error?: string } | null = null;
			try {
				parsed = JSON.parse(body) as { error?: string };
			} catch {
				// Non-JSON 200 — assume success (some builds answer plain 200).
			}
			if (parsed?.error) {
				log(dest, "error", `server error in ${ms}ms: ${parsed.error}`);
				return { ok: false, error: parsed.error };
			}
			log(dest, "log", `upload ok in ${ms}ms`);
			return { ok: true, message: "Added to µTorrent" };
		} catch (err: unknown) {
			log(dest, "error", `upload threw: ${(err as Error).message}`);
			return { ok: false, error: (err as Error).message };
		}
	},
};
