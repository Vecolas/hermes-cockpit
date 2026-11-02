# Hermes Cockpit

Hermes Cockpit is a local desktop app that acts as a command center for the
Hermes Agent. It shows your bots, chat, terminal, diffs, previews, files and
status in a single resizable window.

## Stack

- Electron 40 (main process, IPC and WebSocket proxy)
- React 19, TypeScript and Tailwind CSS 4 (renderer)
- Vite 8 with electron-vite

## Prerequisites

- Node.js (a current LTS release or newer) and npm
- Hermes Agent CLI (`hermes`) installed and available on your `PATH`
  (the app also looks in `~/.local/bin`, Homebrew paths on macOS, and
  `%APPDATA%\npm` / `%LOCALAPPDATA%\Programs` on Windows)
- Building the Windows installer from macOS needs network access on the first
  run (electron-builder downloads the Windows Electron zip and NSIS tooling);
  no Wine is required for an unsigned build

## Setup and run

```bash
npm install
npm run dev          # start the Electron app in development
npm run typecheck    # TypeScript check (tsc --noEmit)
npm run build        # production build into out/
```

`npm run dev:web` runs only the renderer in a browser; it needs a backend URL
and token entered manually.

If the app fails with `The requested module 'electron' does not provide an
export named ...`, your shell has `ELECTRON_RUN_AS_NODE` set. Run
`env -u ELECTRON_RUN_AS_NODE npm run dev` instead (on Windows PowerShell:
`Remove-Item Env:ELECTRON_RUN_AS_NODE`).

## Packaging

All artifacts are written to `release/`.

| Command | Result |
| --- | --- |
| `npm run dist` / `npm run dist:mac` | macOS DMG (unsigned) |
| `npm run dist:win` | Windows x64 NSIS installer, `release/Hermes-Cockpit-<version>-win-x64-setup.exe` |
| `npm run pack:win` | Unpacked Windows app in `release/win-unpacked/` (no installer) |

`dist:win` can run on Windows or macOS. The installer is unsigned, so
SmartScreen warns on first launch ("More info", then "Run anyway"). The DMG is
unsigned too: on first launch, right-click the app and choose Open.

## Platform support

macOS is the primary target. The Windows target includes a native window frame
and local `hermes serve` integration. The installer has been built on macOS but
has not been run on a Windows machine. These features are macOS-only and report
an error or an empty state on Windows:

- integrated terminal (needs a POSIX PTY)
- process list, listening ports and GUI app list (`ps`, `lsof`, `osascript`)
- system-audio capture in the transcriber (the transcriber itself looks for a
  Windows venv at `.venv\Scripts\python.exe`, but is not validated there)

The swarm scripts under `swarm/` have not been validated on Windows. Stopping
the `hermes serve` backend on Windows is a forced `taskkill`, not a graceful
SIGTERM. The Windows installer has been built from macOS but not run on a
Windows machine.

## Hermes backend

The cockpit does not bundle or patch Hermes. On startup the main process
spawns `hermes serve --host 127.0.0.1 --port 0`, reads the port from the
backend ready sentinel, and passes the session token through the environment.
The managed Hermes install (`~/.hermes/hermes-agent`) is consumed locally as
read-only: do not modify it, since `hermes update` overwrites it.

See `HANDOFF.md` for architecture notes and known gotchas, and
`docs/GATEWAY.md` for the backend method map.
