import type { RutorrentDestination } from "../rpc";
import type { DestinationDriver, UploadContext } from "./types";
import { basicAuthHeaders, joinUrl } from "./util";

function log(
	dest: RutorrentDestination,
	level: "log" | "error",
	...args: unknown[]
): void {
	const tag = `[rutorrent ${dest.name} ${dest.url}]`;
	if (level === "error") console.error(tag, ...args);
	else console.log(tag, ...args);
}

function tlsFor(dest: RutorrentDestination) {
	return dest.insecure ? { rejectUnauthorized: false } : undefined;
}

export const rutorrentDriver: DestinationDriver<RutorrentDestination> = {
	async preflight(dest, signal) {
		try {
			const res = await fetch(dest.url, {
				method: "GET",
				headers: basicAuthHeaders(dest.username, dest.password),
				signal,
				tls: tlsFor(dest),
			});
			if (res.status === 401) {
				return {
					destinationId: dest.id,
					ok: false,
					detail: "Authentication failed: bad username/password?",
				};
			}
			return {
				destinationId: dest.id,
				ok: res.ok,
				detail: `HTTP ${res.status}`,
			};
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
		const form = new FormData();
		form.append(
			"torrent_file",
			new Blob([ctx.bytes], { type: "application/x-bittorrent" }),
			ctx.filename,
		);
		if (dest.label) form.append("label", dest.label);
		if (dest.downloadLocation) form.append("dir_edit", dest.downloadLocation);
		if (dest.addPaused) form.append("torrents_start_stopped", "1");
		try {
			const res = await fetch(joinUrl(dest.url, "/php/addtorrent.php"), {
				method: "POST",
				headers: basicAuthHeaders(dest.username, dest.password),
				body: form,
				tls: tlsFor(dest),
			});
			const ms = (performance.now() - start).toFixed(0);
			const body = await res.text().catch(() => "");
			if (res.status === 401) {
				return { ok: false, error: "Authentication failed: bad username/password?" };
			}
			if (!res.ok) {
				log(dest, "error", `upload failed in ${ms}ms HTTP ${res.status}`);
				return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
			}
			// addtorrent.php redirects to ...?result[]=Success / result[]=Failed…
			// (fetch follows the redirect, so the marker ends up in res.url) or
			// embeds addTorrentSuccess/addTorrentFailed in the response body.
			const evidence = `${res.url} ${body}`;
			if (/Failed/i.test(evidence)) {
				log(dest, "error", `server reported failure in ${ms}ms: ${evidence.slice(0, 200)}`);
				return { ok: false, error: "ruTorrent reported the add failed" };
			}
			log(dest, "log", `upload ok in ${ms}ms`);
			return { ok: true, message: "Added to ruTorrent" };
		} catch (err: unknown) {
			log(dest, "error", `upload threw: ${(err as Error).message}`);
			return { ok: false, error: (err as Error).message };
		}
	},
};
