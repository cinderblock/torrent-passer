# torrent-passer

A tiny GUI tool that opens when you double-click a `.torrent` file and forwards
it to a configurable destination — a `POST` URL or a Deluge instance.

Built on [Electrobun](https://blackboard.sh/electrobun/) (Bun + native
WebView2 on Windows) for a small binary and fast cold start.

## Status

- Cross-platform: Windows, Linux, and macOS builds via CI (Windows is the
  most battle-tested). Download from
  [Releases](https://github.com/cinderblock/torrent-passer/releases), or grab
  a recent CI run's artifacts.
- Destination drivers:
  - **qBittorrent** — WebUI API v2 (`auth/login` cookie session +
    `torrents/add`). Save path, category, add paused. Leave the username
    empty to use qBittorrent's "bypass authentication for localhost" mode.
  - **Transmission** — JSON-RPC (`torrent-add` with base64 metainfo, the
    409 `X-Transmission-Session-Id` handshake, optional Basic auth).
    Download dir, add paused; duplicates count as success.
  - **Deluge WebUI** — `/upload` + `web.add_torrents` against the Deluge
    Web UI (port 8112). Supports per-destination download location and
    "add paused".
  - **Deluge daemon (port 58846)** — full TLS rencode RPC via
    [`deluge-rpc-socket`](https://github.com/cinderblock/node-deluge-rpc).
    Defaults to protocol version 1 (Deluge 2.x). Set `insecure` for
    self-signed certs.
  - **ruTorrent** — `php/addtorrent.php` multipart upload with optional
    Basic auth, label, download directory, and start-stopped.
  - **µTorrent (classic)** — WebUI `token.html` + `action=add-file`.
  - **POST URL** — `multipart/form-data` with the torrent file in a configurable
    form field, plus arbitrary headers and extra form fields.

## Develop

Requires [Bun](https://bun.sh) (tested with 1.3.6).

```sh
bun install
bun start              # dev build, opens the window (133 MB unpacked)
bun run dev            # dev build with file watcher
bun run typecheck
bun run build          # dev bundle into ./build
bunx electrobun build --env=stable   # minified production build,
                                     #   ~32 MB self-extracting installer
```

Electrobun builds for the host platform only. CI
([build.yml](.github/workflows/build.yml)) builds Windows x64, Linux
x64/arm64, and macOS arm64/x64 on every push to `main` (artifacts kept 7
days) and attaches them to a GitHub release on `v*` tags.

## Wiring up the `.torrent` file association

Electrobun's built-in `app.fileAssociations` is macOS-only today. On Windows
and Linux the app shows an **Install .torrent association** button in the
footer that registers a user-scope handler:

- **Windows** — `HKCU\Software\Classes` keys via `reg.exe`.
- **Linux** — a `.desktop` entry in `$XDG_DATA_HOME/applications` plus
  `xdg-mime default … application/x-bittorrent` (requires `xdg-utils`).

Click it once and the OS will route double-clicks at the app.

Electrobun's launcher currently drops its CLI arguments before the app sees
them ([electrobun#483](https://github.com/blackboardsh/electrobun/issues/483)),
so on Windows and Linux the app recovers the double-clicked path from the
parent launcher process's command line (`src/bun/win-parent-cmdline.ts`,
`src/bun/linux-parent-cmdline.ts`). Once that issue is fixed upstream these
workarounds can be deleted.

If you'd rather do it by hand on Windows, this PowerShell snippet is what the
button runs:

```powershell
$exe = 'C:\Path\To\torrent-passer.exe'
reg add 'HKCU\Software\Classes\.torrent' /ve /d 'torrent-passer.File' /f
reg add 'HKCU\Software\Classes\torrent-passer.File' /ve /d 'BitTorrent file' /f
reg add 'HKCU\Software\Classes\torrent-passer.File\shell\open\command' /ve `
  /d ('"{0}" "%1"' -f $exe) /f
```

On macOS, the standard `app.fileAssociations` config in `electrobun.config.ts`
generates the `CFBundleDocumentTypes` entries automatically — no in-app button
needed.

## Updates

Stable builds self-update via Electrobun's built-in updater. On launch the app
checks `releases/latest/download/…-update.json` (GitHub always redirects that
path to the newest release), and when a newer build is available an **Update**
button appears in the footer. Clicking it downloads and installs, then
relaunches into the new version.

CI generates a delta patch against the previous release at build time, so the
common case is a tiny download (the v0.3.0 → v0.4.0 patch is ~69 KB) with a
full-bundle fallback when no patch applies. Dev builds have updates disabled.

Note: macOS builds are currently unsigned, so the first launch needs
right-click → Open, and self-update on macOS is best-effort until signing is
set up.

## Config

Destinations live at `%APPDATA%\torrent-passer\config.json` (Windows),
`~/Library/Application Support/torrent-passer/config.json` (macOS), or
`$XDG_CONFIG_HOME/torrent-passer/config.json` (Linux). Edit them from the
in-app settings window, or hand-edit the JSON — it's a simple schema:

```jsonc
{
  "destinations": [
    {
      "id": "deluge-home",
      "name": "Home Deluge",
      "kind": "deluge-web",
      "url": "http://192.168.1.10:8112",
      "password": "...",
      "downloadLocation": "/data/downloads"
    },
    {
      "id": "ingest",
      "name": "Ingest API",
      "kind": "post-url",
      "url": "https://ingest.example.com/torrent",
      "headers": { "Authorization": "Bearer ..." }
    }
  ],
  "lastUsedId": "deluge-home"
}
```

## Startup parallelization

The main process kicks off four pieces of work the moment it boots:

1. Reading the torrent file off disk.
2. Loading the destinations config.
3. Preflighting each destination (Deluge auth, etc.) so the first upload
   already has a warm session.
4. Creating the WebView window.

The webview's first action is a single `getInitialState` RPC call that resolves
once those promises land. Preflight updates stream back via push messages, so
the list can already render before the slowest endpoint has answered.

## Keyboard shortcuts

- `1`–`9` — send to that destination
- `↑` / `↓` — change selection
- `Enter` — send to the highlighted destination
- `Esc` — close the window
