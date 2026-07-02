import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

const asPtr = (n: number | bigint): Pointer => Number(n) as unknown as Pointer;

// Electrobun's native launcher.exe receives the file-association path (the
// OS runs `launcher.exe "C:\foo.torrent"`) but spawns `bun.exe main.js`
// WITHOUT forwarding the arg — so neither main.js nor our Worker ever see
// it via process.argv. The launcher stays alive as our parent process,
// though, and the path is in ITS command line. This reads the parent
// process's command line out of its PEB via Win32 so we can recover the
// dropped argument. Win64-only offsets; returns [] on anything unexpected.

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;

export function getWindowsParentArgs(): string[] {
	if (process.platform !== "win32") return [];

	const k = dlopen("kernel32.dll", {
		GetCurrentProcess: { args: [], returns: FFIType.ptr },
		OpenProcess: {
			args: [FFIType.u32, FFIType.i32, FFIType.u32],
			returns: FFIType.ptr,
		},
		ReadProcessMemory: {
			args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr],
			returns: FFIType.i32,
		},
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	const nt = dlopen("ntdll.dll", {
		NtQueryInformationProcess: {
			args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
			returns: FFIType.i32,
		},
	});

	let parentHandle = 0;
	try {
		// PROCESS_BASIC_INFORMATION (Win64, 48 bytes):
		//   +8 PebBaseAddress, +40 InheritedFromUniqueProcessId (parent PID)
		const myPbi = new Uint8Array(48);
		const cur = k.symbols["GetCurrentProcess"]() ?? 0;
		if (
			nt.symbols["NtQueryInformationProcess"](
				asPtr(cur),
				0,
				ptr(myPbi),
				48,
				null,
			) !== 0
		) {
			return [];
		}
		const parentPid = Number(new DataView(myPbi.buffer).getBigUint64(40, true));
		if (!parentPid) return [];

		parentHandle = Number(
			k.symbols["OpenProcess"](
				PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
				0,
				parentPid,
			) ?? 0,
		);
		if (!parentHandle) return [];

		const parentPbi = new Uint8Array(48);
		if (
			nt.symbols["NtQueryInformationProcess"](
				asPtr(parentHandle),
				0,
				ptr(parentPbi),
				48,
				null,
			) !== 0
		) {
			return [];
		}
		const pebBase = new DataView(parentPbi.buffer).getBigUint64(8, true);
		if (!pebBase) return [];

		const readMem = (addr: bigint, size: number): DataView | null => {
			const buf = new Uint8Array(size);
			const ok = k.symbols["ReadProcessMemory"](
				asPtr(parentHandle),
				asPtr(addr),
				ptr(buf),
				BigInt(size),
				null,
			);
			return ok ? new DataView(buf.buffer) : null;
		};

		// PEB.ProcessParameters @ +0x20
		const pp = readMem(pebBase + 0x20n, 8);
		if (!pp) return [];
		const procParams = pp.getBigUint64(0, true);
		if (!procParams) return [];

		// RTL_USER_PROCESS_PARAMETERS.CommandLine (UNICODE_STRING) @ +0x70:
		//   +0 Length (u16 bytes), +8 Buffer (ptr)
		const us = readMem(procParams + 0x70n, 16);
		if (!us) return [];
		const length = us.getUint16(0, true);
		const bufferPtr = us.getBigUint64(8, true);
		if (!length || !bufferPtr) return [];

		const cmd = readMem(bufferPtr, length);
		if (!cmd) return [];
		const cmdline = new TextDecoder("utf-16le").decode(cmd.buffer);
		return tokenizeWindowsCmdline(cmdline).slice(1); // drop exe path
	} catch (err) {
		console.error("[torrent-passer] parent-cmdline read failed:", err);
		return [];
	} finally {
		if (parentHandle) {
			try {
				k.symbols["CloseHandle"](asPtr(parentHandle));
			} catch {}
		}
	}
}

// Minimal CommandLineToArgv-ish tokenizer: splits on whitespace, respects
// double-quoted segments. Good enough for `"<exe>" "<path>"` shapes.
function tokenizeWindowsCmdline(cmd: string): string[] {
	const args: string[] = [];
	let i = 0;
	const n = cmd.length;
	while (i < n) {
		while (i < n && (cmd[i] === " " || cmd[i] === "\t")) i++;
		if (i >= n) break;
		let tok = "";
		if (cmd[i] === '"') {
			i++;
			while (i < n && cmd[i] !== '"') {
				tok += cmd[i];
				i++;
			}
			i++; // closing quote
		} else {
			while (i < n && cmd[i] !== " " && cmd[i] !== "\t") {
				tok += cmd[i];
				i++;
			}
		}
		args.push(tok);
	}
	return args;
}
