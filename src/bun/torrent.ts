import { basename } from "node:path";
import type { TorrentInfo } from "./rpc";

const utf8 = new TextDecoder("utf-8");
const ascii = new TextDecoder("ascii");

export function resolveTorrentArg(argv: readonly string[]): string | null {
	for (const arg of argv) {
		if (!arg || arg.startsWith("-")) continue;
		if (arg.startsWith("file://")) {
			try {
				return decodeURI(new URL(arg).pathname).replace(/^\/([A-Za-z]:)/, "$1");
			} catch {
				continue;
			}
		}
		if (arg.toLowerCase().endsWith(".torrent")) return arg;
	}
	return null;
}

export interface LoadedTorrent {
	info: TorrentInfo;
	bytes: Uint8Array<ArrayBuffer>;
}

export async function readTorrent(path: string): Promise<LoadedTorrent> {
	const ab = await Bun.file(path).arrayBuffer();
	const bytes = new Uint8Array(ab);
	const name = extractTorrentName(bytes);
	return {
		bytes,
		info: {
			path,
			filename: basename(path),
			size: bytes.byteLength,
			...(name !== undefined ? { name } : {}),
		},
	};
}

// Minimal bencode scan that finds the `info.name` field without building a
// full parse tree. Returns undefined if the structure isn't what we expect.
function extractTorrentName(buf: Uint8Array): string | undefined {
	const needle = new TextEncoder().encode("4:info");
	const idx = indexOfSubarray(buf, needle);
	if (idx < 0) return undefined;
	let i = idx + needle.length;
	if (buf[i] !== 0x64) return undefined;
	i++;
	while (i < buf.length && buf[i] !== 0x65) {
		const keyLen = readBencodeStringLen(buf, i);
		if (!keyLen) return undefined;
		const keyStart = keyLen.colon + 1;
		const keyEnd = keyStart + keyLen.len;
		if (keyEnd > buf.length) return undefined;
		const key = utf8.decode(buf.subarray(keyStart, keyEnd));
		i = keyEnd;
		if (key === "name") {
			const valLen = readBencodeStringLen(buf, i);
			if (!valLen) return undefined;
			const valStart = valLen.colon + 1;
			const valEnd = valStart + valLen.len;
			if (valEnd > buf.length) return undefined;
			return utf8.decode(buf.subarray(valStart, valEnd));
		}
		i = skipBencodeValue(buf, i);
		if (i < 0) return undefined;
	}
	return undefined;
}

function readBencodeStringLen(
	buf: Uint8Array,
	start: number,
): { len: number; colon: number } | null {
	let i = start;
	while (i < buf.length && buf[i] !== 0x3a) {
		if (buf[i]! < 0x30 || buf[i]! > 0x39) return null;
		i++;
	}
	if (i >= buf.length) return null;
	const len = Number(ascii.decode(buf.subarray(start, i)));
	if (!Number.isFinite(len) || len < 0) return null;
	return { len, colon: i };
}

function skipBencodeValue(buf: Uint8Array, start: number): number {
	if (start >= buf.length) return -1;
	const c = buf[start]!;
	if (c === 0x69) {
		const end = buf.indexOf(0x65, start + 1);
		return end < 0 ? -1 : end + 1;
	}
	if (c === 0x6c || c === 0x64) {
		let i = start + 1;
		while (i < buf.length && buf[i] !== 0x65) {
			if (c === 0x64) {
				const k = readBencodeStringLen(buf, i);
				if (!k) return -1;
				i = k.colon + 1 + k.len;
			}
			i = skipBencodeValue(buf, i);
			if (i < 0) return -1;
		}
		return i + 1;
	}
	if (c >= 0x30 && c <= 0x39) {
		const len = readBencodeStringLen(buf, start);
		if (!len) return -1;
		return len.colon + 1 + len.len;
	}
	return -1;
}

function indexOfSubarray(haystack: Uint8Array, needle: Uint8Array): number {
	if (needle.length === 0) return 0;
	const limit = haystack.length - needle.length;
	for (let i = 0; i <= limit; i++) {
		let match = true;
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) {
				match = false;
				break;
			}
		}
		if (match) return i;
	}
	return -1;
}
