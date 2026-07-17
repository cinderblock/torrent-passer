import type { PreflightStatus, TransmissionDestination } from "../rpc";
import type { DestinationDriver, UploadContext } from "./types";
import { basicAuthHeaders } from "./util";

function log(
	dest: TransmissionDestination,
	level: "log" | "error",
	...args: unknown[]
): void {
	const tag = `[transmission ${dest.name} ${dest.url}]`;
	if (level === "error") console.error(tag, ...args);
	else console.log(tag, ...args);
}

// Per-destination X-Transmission-Session-Id cache (the CSRF token from the
// 409 handshake). Refreshed automatically whenever the server 409s.
const sessionIds = new Map<string, string>();

function rpcUrl(dest: TransmissionDestination): string {
	const u = new URL(dest.url);
	// Bare origin → the default RPC path. A URL that already has a path is
	// used verbatim (custom rpc-url setups, reverse proxies).
	if (u.pathname === "/" || u.pathname === "") {
		u.pathname = "/transmission/rpc";
	}
	return u.toString();
}

interface RpcEnvelope<T> {
	result: string;
	arguments: T;
}

async function rpcCall<T>(
	dest: TransmissionDestination,
	method: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<T> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...basicAuthHeaders(dest.username, dest.password),
		};
		const sid = sessionIds.get(dest.id);
		if (sid) headers["X-Transmission-Session-Id"] = sid;
		const res = await fetch(rpcUrl(dest), {
			method: "POST",
			headers,
			body: JSON.stringify({ method, arguments: args }),
			signal,
			tls: dest.insecure ? { rejectUnauthorized: false } : undefined,
		});
		if (res.status === 409) {
			const next = res.headers.get("x-transmission-session-id");
			if (!next) throw new Error("Transmission 409 without a session id");
			sessionIds.set(dest.id, next);
			continue; // retry with the fresh CSRF token
		}
		if (res.status === 401) {
			throw new Error("Authentication failed: bad username/password?");
		}
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
		const data = (await res.json()) as RpcEnvelope<T>;
		if (data.result !== "success") throw new Error(data.result);
		return data.arguments;
	}
	throw new Error("Transmission session handshake failed");
}

export const transmissionDriver: DestinationDriver<TransmissionDestination> = {
	async preflight(dest, signal) {
		try {
			const session = await rpcCall<{
				version?: string;
				"download-dir"?: string;
			}>(dest, "session-get", {}, signal);
			const version = session.version?.split(" ")[0];
			const status: PreflightStatus = {
				destinationId: dest.id,
				ok: true,
				detail: version ? `Transmission ${version}` : "connected",
			};
			if (version) status.version = version;
			if (session["download-dir"]) {
				status.defaultDownloadLocation = session["download-dir"];
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
			const args: Record<string, unknown> = {
				metainfo: Buffer.from(ctx.bytes).toString("base64"),
			};
			if (dest.downloadLocation) args["download-dir"] = dest.downloadLocation;
			if (dest.addPaused !== undefined) args["paused"] = dest.addPaused;
			const result = await rpcCall<{
				"torrent-added"?: { name?: string };
				"torrent-duplicate"?: { name?: string };
			}>(dest, "torrent-add", args);
			const ms = (performance.now() - start).toFixed(0);
			if (result["torrent-duplicate"]) {
				log(dest, "log", `duplicate in ${ms}ms — treating as success`);
				return { ok: true, message: "Already in Transmission" };
			}
			if (!result["torrent-added"]) {
				log(dest, "error", `torrent-add returned neither added nor duplicate in ${ms}ms`);
				return { ok: false, error: "Transmission did not add the torrent" };
			}
			log(dest, "log", `upload ok in ${ms}ms`);
			return { ok: true, message: "Added to Transmission" };
		} catch (err: unknown) {
			log(dest, "error", `upload failed: ${(err as Error).message}`);
			return { ok: false, error: (err as Error).message };
		}
	},
};
