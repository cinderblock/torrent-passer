import type {
	Destination,
	PreflightStatus,
	UploadResult,
} from "../rpc";

export interface UploadContext {
	bytes: Uint8Array<ArrayBuffer>;
	filename: string;
	torrentName?: string;
}

export interface DestinationDriver<D extends Destination = Destination> {
	preflight(dest: D, signal: AbortSignal): Promise<PreflightStatus>;
	upload(dest: D, ctx: UploadContext): Promise<UploadResult>;
}
