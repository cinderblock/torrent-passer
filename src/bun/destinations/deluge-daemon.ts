import { Socket, connect as netConnect } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import DelugeRPC, { isRPCError } from "deluge-rpc-socket";
import type { DelugeDaemonDestination, PreflightStatus } from "../rpc";
import type { DestinationDriver, UploadContext } from "./types";

function log(dest: DelugeDaemonDestination, level: "log" | "error", ...args: unknown[]): void {
	const tag = `[deluge-daemon ${dest.name} ${dest.host}:${dest.port}]`;
	if (level === "error") console.error(tag, ...args);
	else console.log(tag, ...args);
}

// Per-destination cache of the protocol version we successfully detected, so
// "auto" doesn't pay the TLS-then-TCP fallback cost on every request.
const detectedVersion = new Map<string, 0 | 1>();

function connectTLS(dest: DelugeDaemonDestination): Promise<Socket> {
	const start = performance.now();
	return new Promise<Socket>((resolve, reject) => {
		const opts: ConnectionOptions = {
			host: dest.host,
			port: dest.port,
			rejectUnauthorized: !dest.insecure,
		};
		const sock = tlsConnect(opts);
		const onError = (err: Error) => reject(err);
		sock.once("error", onError);
		sock.once("secureConnect", () => {
			sock.off("error", onError);
			const cert = sock.getPeerCertificate?.();
			log(
				dest,
				"log",
				`TLS established in ${(performance.now() - start).toFixed(0)}ms`,
				cert?.subject ? `peer=${JSON.stringify(cert.subject)}` : "",
				sock.authorized
					? "authorized"
					: `unauthorized (${sock.authorizationError ?? "no reason"})`,
			);
			resolve(sock);
		});
	});
}

function connectTCP(dest: DelugeDaemonDestination): Promise<Socket> {
	const start = performance.now();
	return new Promise<Socket>((resolve, reject) => {
		const sock = netConnect({ host: dest.host, port: dest.port });
		const onError = (err: Error) => reject(err);
		sock.once("error", onError);
		sock.once("connect", () => {
			sock.off("error", onError);
			log(
				dest,
				"log",
				`TCP connected in ${(performance.now() - start).toFixed(0)}ms`,
			);
			resolve(sock);
		});
	});
}

async function connectSocket(
	dest: DelugeDaemonDestination,
): Promise<{ socket: Socket; version: 0 | 1 }> {
	const configured = dest.protocolVersion ?? "auto";

	if (configured === "auto") {
		const cached = detectedVersion.get(dest.id);
		if (cached !== undefined) {
			log(dest, "log", `using cached auto-detected protocol v${cached}`);
			const socket = cached === 1 ? await connectTLS(dest) : await connectTCP(dest);
			return { socket, version: cached };
		}
		log(dest, "log", "auto: trying TLS first…");
		try {
			const socket = await connectTLS(dest);
			detectedVersion.set(dest.id, 1);
			return { socket, version: 1 };
		} catch (err) {
			log(
				dest,
				"log",
				`auto: TLS failed (${(err as Error).message}); falling back to plain TCP`,
			);
			const socket = await connectTCP(dest);
			detectedVersion.set(dest.id, 0);
			return { socket, version: 0 };
		}
	}

	log(
		dest,
		"log",
		`connecting (configured v${configured}${dest.insecure ? ", insecure" : ""})`,
	);
	const socket =
		configured === 1 ? await connectTLS(dest) : await connectTCP(dest);
	return { socket, version: configured };
}

export function _clearProtocolCache(destId: string): void {
	detectedVersion.delete(destId);
}

async function withDaemon<T>(
	dest: DelugeDaemonDestination,
	fn: (
		rpc: ReturnType<typeof DelugeRPC>,
		expect: <R>(promise: Promise<unknown>, what: string) => Promise<R>,
	) => Promise<T>,
): Promise<T> {
	const { socket, version } = await connectSocket(dest);
	try {
		const rpc = DelugeRPC(socket, {
			protocolVersion: version,
		});
		const expect = async <R>(
			promise: Promise<unknown>,
			what: string,
		): Promise<R> => {
			const r = await promise;
			if (isRPCError(r as never)) {
				// Dump the raw error shape so we can see Deluge's full payload
				// (type / message / traceback) when something goes sideways.
				try {
					log(dest, "error", `${what} raw error: ${JSON.stringify(r)}`);
				} catch {
					log(dest, "error", `${what} raw error (unstringifiable):`, r);
				}
				throw new Error(`Deluge daemon ${what}: ${formatDelugeError(r)}`);
			}
			return r as R;
		};
		log(dest, "log", `login(user=${dest.username})`);
		const loginOk = await expect<number>(
			rpc.daemon.login(dest.username, dest.password).result,
			"login",
		);
		if (typeof loginOk !== "number" || loginOk < 0) {
			throw new Error("Deluge daemon login rejected credentials");
		}
		log(dest, "log", `login ok (auth level ${loginOk})`);
		return await fn(rpc, expect);
	} finally {
		socket.end();
		socket.destroy();
	}
}

// Strip the "Deluge daemon <op>: " prefix and trailing info-hash from
// error messages bubbled up to the UI. Keeps the technical text in the
// terminal log but presents something friendly to the user.
function prettifyDelugeError(msg: string): string {
	// Drop our own wrapper prefix.
	let out = msg.replace(/^Deluge daemon [a-z_]+:\s*/i, "");
	// Drop trailing info-hash in parentheses (40 hex chars).
	out = out.replace(/\s*\([0-9a-f]{40}\)\.?$/i, "");
	// Drop "ExceptionClass: " prefix on Deluge-side errors.
	out = out.replace(/^[A-Z][A-Za-z]*Error:\s*/, "");
	return out.trim() || msg;
}

function formatDelugeError(err: unknown): string {
	if (typeof err === "string") return err;
	if (err && typeof err === "object") {
		const e = err as {
			error?: unknown;
			message?: unknown;
			extra?: unknown[];
			traceback?: unknown;
		};
		const type =
			typeof e.error === "string"
				? e.error
				: e.error !== undefined
					? JSON.stringify(e.error)
					: undefined;
		// v1: e.message is string[]; v0: e.extra is unknown[]
		const msgPieces: string[] = [];
		if (Array.isArray(e.message)) {
			for (const m of e.message)
				msgPieces.push(typeof m === "string" ? m : JSON.stringify(m));
		}
		if (Array.isArray(e.extra)) {
			for (const m of e.extra)
				msgPieces.push(typeof m === "string" ? m : JSON.stringify(m));
		}
		const msg = msgPieces.join(", ");
		if (type || msg) {
			return `${type ?? "Error"}${msg ? `: ${msg}` : ""}`;
		}
		try {
			return JSON.stringify(err);
		} catch {
			return String(err);
		}
	}
	return String(err);
}

export const delugeDaemonDriver: DestinationDriver<DelugeDaemonDestination> = {
	async preflight(dest, signal): Promise<PreflightStatus> {
		try {
			const result = await Promise.race([
				withDaemon(dest, async (rpc, expect) => {
					const info = await expect<string>(
						rpc.daemon.info().result,
						"info",
					);
					let defaultDir: string | undefined;
					try {
						const dir = await expect<string>(
							rpc.core.get_config_value("download_location").result,
							"get_config_value(download_location)",
						);
						if (typeof dir === "string") defaultDir = dir;
					} catch {
						// Non-fatal — the destination still works without the default dir.
					}
					return { version: info, defaultDir };
				}),
				new Promise<never>((_, reject) => {
					const t = setTimeout(
						() => reject(new Error("preflight timeout")),
						5000,
					);
					signal.addEventListener("abort", () => {
						clearTimeout(t);
						reject(new Error("aborted"));
					});
				}),
			]);
			const status: PreflightStatus = {
				destinationId: dest.id,
				ok: true,
				detail: result.version ? `daemon ${result.version}` : "ok",
			};
			if (result.version) status.version = result.version;
			if (result.defaultDir) status.defaultDownloadLocation = result.defaultDir;
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
		log(
			dest,
			"log",
			`upload start filename=${ctx.filename} bytes=${ctx.bytes.byteLength}`,
		);
		const start = performance.now();
		try {
			const result = await withDaemon(dest, async (rpc, expect) => {
				const options: Record<string, unknown> = {};
				if (dest.downloadLocation) {
					options["download_location"] = dest.downloadLocation;
				}
				if (dest.addPaused !== undefined) {
					options["add_paused"] = dest.addPaused;
				}
				log(dest, "log", `add_torrent_file options=${JSON.stringify(options)}`);
				const b64 = Buffer.from(ctx.bytes).toString("base64");
				return expect<string | null>(
					rpc.core.add_torrent_file(
						ctx.filename,
						b64,
						options as { [x: string]: string },
					).result,
					"add_torrent_file",
				);
			});
			const ms = (performance.now() - start).toFixed(0);
			if (result === null) {
				log(dest, "log", `add_torrent_file returned null in ${ms}ms (duplicate?)`);
				return { ok: true, message: "Already in Deluge" };
			}
			log(dest, "log", `add_torrent_file ok in ${ms}ms hash=${result}`);
			return { ok: true, message: "Added to Deluge" };
		} catch (err: unknown) {
			const msg = (err as Error).message;
			if (/already in session/i.test(msg)) {
				log(dest, "log", "torrent already in session — treating as success");
				return { ok: true, message: "Already in Deluge" };
			}
			log(dest, "error", `upload failed: ${msg}`);
			return { ok: false, error: prettifyDelugeError(msg) };
		}
	},
};
