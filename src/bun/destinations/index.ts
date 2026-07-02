import type { Destination, PreflightStatus, UploadResult } from "../rpc";
import { delugeDaemonDriver } from "./deluge-daemon";
import { delugeWebDriver } from "./deluge-web";
import { postUrlDriver } from "./post-url";
import type { DestinationDriver, UploadContext } from "./types";

function driverFor(dest: Destination): DestinationDriver {
	switch (dest.kind) {
		case "post-url":
			return postUrlDriver as DestinationDriver;
		case "deluge-web":
			return delugeWebDriver as DestinationDriver;
		case "deluge-daemon":
			return delugeDaemonDriver as DestinationDriver;
	}
}

export async function preflightDestination(
	dest: Destination,
	signal: AbortSignal,
): Promise<PreflightStatus> {
	return driverFor(dest).preflight(dest, signal);
}

export async function uploadToDestination(
	dest: Destination,
	ctx: UploadContext,
): Promise<UploadResult> {
	return driverFor(dest).upload(dest, ctx);
}
