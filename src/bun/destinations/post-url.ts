import type { PostUrlDestination } from "../rpc";
import type { DestinationDriver } from "./types";

function log(
	dest: PostUrlDestination,
	level: "log" | "error",
	...args: unknown[]
): void {
	const tag = `[post-url ${dest.name} ${dest.url}]`;
	if (level === "error") console.error(tag, ...args);
	else console.log(tag, ...args);
}

export const postUrlDriver: DestinationDriver<PostUrlDestination> = {
	async preflight(dest, signal) {
		try {
			const res = await fetch(dest.url, {
				method: "OPTIONS",
				headers: dest.headers,
				signal,
				tls: dest.insecure ? { rejectUnauthorized: false } : undefined,
			});
			return {
				destinationId: dest.id,
				ok: res.ok || res.status === 405,
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

	async upload(dest, ctx) {
		log(
			dest,
			"log",
			`upload start filename=${ctx.filename} bytes=${ctx.bytes.byteLength} field=${
				dest.formField ?? "file"
			}`,
		);
		const start = performance.now();
		const form = new FormData();
		const field = dest.formField ?? "file";
		form.append(
			field,
			new Blob([ctx.bytes], { type: "application/x-bittorrent" }),
			ctx.filename,
		);
		if (dest.extraFields) {
			for (const [k, v] of Object.entries(dest.extraFields)) {
				form.append(k, v);
			}
		}
		try {
			const res = await fetch(dest.url, {
				method: "POST",
				headers: dest.headers,
				body: form,
				tls: dest.insecure ? { rejectUnauthorized: false } : undefined,
			});
			const ms = (performance.now() - start).toFixed(0);
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				log(
					dest,
					"error",
					`upload failed in ${ms}ms HTTP ${res.status} ${res.statusText}${
						body ? ` body=${body.slice(0, 200)}` : ""
					}`,
				);
				return {
					ok: false,
					error: `HTTP ${res.status} ${res.statusText}${
						body ? `: ${body.slice(0, 200)}` : ""
					}`,
				};
			}
			log(dest, "log", `upload ok in ${ms}ms HTTP ${res.status}`);
			return { ok: true, message: `HTTP ${res.status}` };
		} catch (err: unknown) {
			log(dest, "error", `upload threw: ${(err as Error).message}`);
			return { ok: false, error: (err as Error).message };
		}
	},
};
