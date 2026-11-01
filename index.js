import { delimiter, join } from "node:path";
import { BrowserWindow, app, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
// src/main/backend.ts
var HERMES_DIR_CANDIDATES = [
	join(homedir(), ".local", "bin"),
	"/opt/homebrew/bin",
	"/usr/local/bin"
];
function resolveHermesBin() {
	if (process.env.HERMES_BIN && existsSync(process.env.HERMES_BIN)) return process.env.HERMES_BIN;
	for (const dir of HERMES_DIR_CANDIDATES) {
		const candidate = join(dir, "hermes");
		if (existsSync(candidate)) return candidate;
	}
	return "hermes";
}
function childEnv() {
	const path = [HERMES_DIR_CANDIDATES.join(delimiter), process.env.PATH ?? ""].join(delimiter);
	const env = {
		...process.env,
		PATH: path
	};
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
}
var READY_RE = /(?<!\w)HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)/;
var SPAWN_TIMEOUT_MS = 9e4;
var current = null;
var starting = null;
function ensureBackend() {
	if (current) return Promise.resolve(current.info);
	if (starting) return starting;
	starting = start().finally(() => {
		starting = null;
	});
	return starting;
}
function start() {
	return new Promise((resolve, reject) => {
		const token = randomBytes(24).toString("base64url");
		const child = spawn(resolveHermesBin(), [
			"serve",
			"--host",
			"127.0.0.1",
			"--port",
			"0"
		], {
			env: {
				...childEnv(),
				HERMES_DASHBOARD_SESSION_TOKEN: token
			},
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let buffer = "";
		const tail = () => buffer.slice(-2e3);
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {}
			reject(/* @__PURE__ */ new Error(`hermes serve não respondeu em ${SPAWN_TIMEOUT_MS / 1e3}s.\n${tail()}`));
		}, SPAWN_TIMEOUT_MS);
		const onData = (chunk) => {
			buffer += chunk.toString("utf8");
			if (buffer.length > 64e3) buffer = buffer.slice(-32e3);
			const m = buffer.match(READY_RE);
			if (!m) return;
			clearTimeout(timer);
			const port = Number(m[1]);
			const info = {
				baseUrl: `http://127.0.0.1:${port}`,
				wsUrl: `ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`,
				token,
				pid: child.pid ?? 0
			};
			current = {
				child,
				info
			};
			child.stdout?.off("data", onData);
			child.stderr?.off("data", onData);
			resolve(info);
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", (err) => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error(`falha ao iniciar "hermes serve": ${err.message}`));
		});
		child.once("exit", (code) => {
			if (current?.child === child) {
				current = null;
				return;
			}
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error(`hermes serve encerrou antes do ready (código ${code}).\n${tail()}`));
		});
	});
}
async function apiFetch(path) {
	const info = await ensureBackend();
	const res = await fetch(`${info.baseUrl}${path}`, { headers: { "x-hermes-session-token": info.token } });
	const text = await res.text();
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
function stopBackend() {
	if (!current) return;
	try {
		current.child.kill();
	} catch {}
	current = null;
}
// src/main/index.ts
function createWindow() {
	const win = new BrowserWindow({
		width: 1480,
		height: 920,
		minWidth: 1100,
		minHeight: 700,
		backgroundColor: "#0b0d10",
		title: "Hermes Cockpit",
		titleBarStyle: "hiddenInset",
		trafficLightPosition: {
			x: 14,
			y: 14
		},
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.mjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false
		}
	});
	win.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: "deny" };
	});
	if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
	else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}
app.whenReady().then(() => {
	ipcMain.handle("hermes:backend", () => ensureBackend());
	ipcMain.handle("hermes:api", (_event, path) => apiFetch(path));
	createWindow();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => stopBackend());
export {};
