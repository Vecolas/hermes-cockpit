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

## Usage

```bash
npm install
npm run dev          # start the Electron app in development
npm run typecheck    # TypeScript check (tsc --noEmit)
npm run build        # production build into out/
npm run dist         # build and package a macOS DMG into release/
```

`npm run dev:web` runs only the renderer in a browser; it needs a backend URL
and token entered manually.

If the app fails with `The requested module 'electron' does not provide an
export named ...`, your shell has `ELECTRON_RUN_AS_NODE` set. Run
`env -u ELECTRON_RUN_AS_NODE npm run dev` instead.

The DMG is unsigned. On first launch, right-click the app and choose Open.

## Hermes backend

The cockpit does not bundle or patch Hermes. On startup the main process
spawns `hermes serve --host 127.0.0.1 --port 0`, reads the port from the
backend ready sentinel, and passes the session token through the environment.
The managed Hermes install (`~/.hermes/hermes-agent`) is consumed locally as
read-only: do not modify it, since `hermes update` overwrites it.

See `HANDOFF.md` for architecture notes and known gotchas, and
`docs/GATEWAY.md` for the backend method map.
