import type { ElectrobunConfig } from "electrobun";

const isProd = process.argv.some(
	(a) => a === "--env=stable" || a === "--env=canary",
);

const bunBuildOptions = {
	minify: isProd,
	define: {
		"process.env.NODE_ENV": isProd ? '"production"' : '"development"',
	},
} as const;

const viewBuildOptions = {
	minify: isProd,
	define: {
		"process.env.NODE_ENV": isProd ? '"production"' : '"development"',
	},
} as const;

export default {
	app: {
		name: "torrent-passer",
		identifier: "dev.torrentpasser.app",
		version: "0.4.0",
		description:
			"Forward .torrent files to a configurable destination (POST URL or Deluge).",
		// File associations are macOS-only in Electrobun today.
		// On Windows/Linux we register the association ourselves at runtime
		// via the in-app "Install file association" button.
		fileAssociations: [
			{
				ext: ["torrent"],
				name: "BitTorrent File",
				role: "Viewer",
			},
		],
	},
	build: {
		bun: { ...bunBuildOptions, entrypoint: "src/bun/index.ts" },
		views: {
			mainview: { ...viewBuildOptions, entrypoint: "src/mainview/index.ts" },
		},
		copy: {
			"src/mainview/index.html": "views/mainview/index.html",
			"src/mainview/index.css": "views/mainview/index.css",
		},
		// asar packs the Resources folder into one archive — fewer disk seeks
		// at startup and a smaller on-disk footprint for the small files.
		useAsar: true,
		mac: { bundleCEF: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
	// Self-update: the Updater fetches `{baseUrl}/{channel}-{os}-{arch}-update.json`
	// and the matching `.tar.zst` bundle. GitHub's `releases/latest/download/`
	// path always redirects to the newest release's assets (and fetch follows
	// the redirect), so no separate update server is needed — the CI release
	// job's assets are the update feed. Delta patches are generated at build
	// time by diffing against whatever `latest` currently points at.
	release: {
		baseUrl:
			"https://github.com/cinderblock/torrent-passer/releases/latest/download",
	},
} satisfies ElectrobunConfig;
