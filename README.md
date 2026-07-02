# torrent-passer

A tiny GUI tool that opens when you double-click a `.torrent` file and forwards
it to a configurable destination — a `POST` URL or a Deluge instance.

Built on [Electrobun](https://blackboard.sh/electrobun/) (Bun + native
WebView2 on Windows) for a small binary and fast cold start.

## Status

- Windows-first (works wherever Electrobun runs).
- Destination drivers:
  - **POST URL** — `multipart/form-data` with the torrent file in a configurable
    form field, plus arbitrary headers and extra form fields.
  - **Deluge WebUI** — `/upload` + `web.add_torrents` against the Deluge
    Web UI (port 8112). Supports per-destination download location and
    "add paused".
  - **Deluge daemon (port 58846)** — full TLS rencode RPC via
    [`deluge-rpc-socket`](https://github.com/cinderblock/node-deluge-rpc).
    Defaults to protocol version 1 (Deluge 2.x). Set `insecure` for
    self-signed certs.

## Develop

Requires [Bun](https://bun.sh) (tested with 1.3.6).

```sh
bun install
bun start              # dev build, opens the window (133 MB unpacked)
bun run dev            # dev build with file watcher
bun run typecheck
bun run build          # dev bundle into ./build
bunx electrobun build --env=stable   # minified production build,
                                     #   ~32 MB self-extracting Setup.exe
```

## Wiring up the `.torrent` file association

Electrobun's built-in `app.fileAssociations` is macOS-only today. On Windows
the app shows an **Install .torrent association** button in the footer that
writes user-scope `HKCU\Software\Classes` keys via `reg.exe`. Click it once
and the OS will route double-clicks at `torrent-passer.exe`. (Linux isn't
wired up yet — it would need a `.desktop` file + `xdg-mime`.)

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
