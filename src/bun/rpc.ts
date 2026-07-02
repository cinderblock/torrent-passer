export type DestinationKind = "post-url" | "deluge-web" | "deluge-daemon";

export interface BaseDestination {
	id: string;
	name: string;
	kind: DestinationKind;
}

export interface PostUrlDestination extends BaseDestination {
	kind: "post-url";
	url: string;
	headers?: Record<string, string>;
	formField?: string;
	extraFields?: Record<string, string>;
	insecure?: boolean;
}

export interface DelugeWebDestination extends BaseDestination {
	kind: "deluge-web";
	url: string;
	password: string;
	downloadLocation?: string;
	addPaused?: boolean;
	insecure?: boolean;
}

export interface DelugeDaemonDestination extends BaseDestination {
	kind: "deluge-daemon";
	host: string;
	port: number;
	username: string;
	password: string;
	downloadLocation?: string;
	addPaused?: boolean;
	// "auto" probes TLS first then plain TCP and caches the result.
	// 1 = Deluge 2.x (TLS). 0 = Deluge 1.x (plain TCP).
	protocolVersion?: 0 | 1 | "auto";
	// Accept self-signed daemon TLS certificates.
	insecure?: boolean;
}

export interface FileAssociationStatus {
	platform: NodeJS.Platform;
	supported: boolean;
	installed: boolean;
	detail?: string;
}

export type Destination =
	| PostUrlDestination
	| DelugeWebDestination
	| DelugeDaemonDestination;

export interface Config {
	destinations: Destination[];
	lastUsedId?: string;
}

export interface TorrentInfo {
	path: string;
	filename: string;
	size: number;
	name?: string;
}

export interface UploadResult {
	ok: boolean;
	message?: string;
	error?: string;
}

export interface PreflightStatus {
	destinationId: string;
	ok: boolean;
	detail?: string;
	// Server software version when the driver can determine it
	// (e.g. Deluge daemon.info() result like "2.1.1").
	version?: string;
	// Server's default download location (Deluge daemon's
	// core.get_config_value("download_location")). Used as fallback when
	// the destination doesn't override `downloadLocation`.
	defaultDownloadLocation?: string;
}

export interface InitialState {
	torrent: TorrentInfo | null;
	config: Config;
	preflight: PreflightStatus[];
	fileAssociation: FileAssociationStatus;
}

export type AppRPC = {
	bun: {
		requests: {
			getInitialState: { params: void; response: InitialState };
			upload: {
				params: { destinationId: string };
				response: UploadResult;
			};
			closeWindow: { params: void; response: void };
			getConfig: { params: void; response: Config };
			saveConfig: { params: { config: Config }; response: void };
			installFileAssociation: {
				params: void;
				response: FileAssociationStatus;
			};
			uninstallFileAssociation: {
				params: void;
				response: FileAssociationStatus;
			};
			pickTorrent: { params: void; response: TorrentInfo | null };
			logToBun: { params: { msg: string }; response: void };
		};
		messages: Record<never, unknown>;
	};
	webview: {
		requests: Record<never, { params: unknown; response: unknown }>;
		messages: {
			preflightUpdate: { status: PreflightStatus };
			configChanged: { config: Config };
			fileAssociationChanged: { status: FileAssociationStatus };
			torrentChanged: { torrent: TorrentInfo | null };
		};
	};
};
