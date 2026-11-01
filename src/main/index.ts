import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Menu, session, shell, type MenuItemConstructorOptions } from 'electron'
import { apiFetch, type ApiInit, ensureBackend, hasBackend, stopBackend, stopBackendGracefully } from './backend'
import { registerDomainIpc } from './ipc'
import { closeAllWs, registerWsProxy } from './wsproxy'

// Topbar do renderer assumida com ~44px de altura: os traffic lights (12px)
// ficam centrados verticalmente nela (y=15) e a 14px da borda esquerda. O
// renderer deve reservar ~80px à esquerda da topbar para não colidir.
const TRAFFIC_LIGHTS = { x: 14, y: 15 }

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    // Abaixo de 1100px lógicos o renderer entra no modo estreito (rail/dock em
    // gavetas, strip com scroll) — a janela precisa poder chegar lá.
    minWidth: 720,
    minHeight: 700,
    backgroundColor: '#0b0d10',
    title: 'Hermes Cockpit',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: TRAFFIC_LIGHTS,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

// Menu da aplicação sem os papéis de zoom do Chromium (zoomIn/zoomOut/
// resetZoom): ⌘= / ⌘- / ⌘0 ficam com o renderer, que aplica a escala da UI
// via CSS zoom em #root (ver renderer lib/theme.ts). Mantém Edit (copiar/colar) e Window.
function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Origem do próprio renderer (empacotado: file://; dev: servidor do electron-vite). */
function isOwnOrigin(url: string): boolean {
  if (url.startsWith('file://')) return true
  const dev = process.env.ELECTRON_RENDERER_URL
  return Boolean(dev && url.startsWith(new URL(dev).origin))
}

void app.whenReady().then(() => {
  installMenu()
  // Microfone (ditado/transcriber) só para a página do próprio cockpit; iframes
  // de preview (localhost:<porta>) e qualquer outra origem não ganham mídia.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const origin = details.requestingUrl || wc.getURL()
    cb(permission === 'media' && isOwnOrigin(origin))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && isOwnOrigin(origin))
  // O renderer recebe a info do backend MASCARADA: sem token, wsUrl sem
  // ?token=. WS e REST passam pelo main (wsproxy / hermes:api), que conhece o
  // token. O wsUrl continua servindo de marcador para HermesRpc.connect().
  ipcMain.handle('hermes:backend', async () => {
    const info = await ensureBackend()
    const ws = new URL(info.wsUrl)
    ws.searchParams.delete('token')
    return { baseUrl: info.baseUrl, wsUrl: ws.toString(), token: '', pid: info.pid }
  })
  ipcMain.handle('hermes:api', (_event, path: string, init?: ApiInit) => apiFetch(path, init ?? {}))
  registerWsProxy()
  registerDomainIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── Lifecycle: o serve morre com o app ──────────────────────────────────────
// Camadas (da mais graciosa à última trincheira):
//   1. before-quit: adia o quit, fecha WS, SIGTERM no grupo do serve, espera
//      até 2.5s (flush de transcripts), SIGKILL se preciso, e então sai.
//   2. will-quit: SIGTERM síncrono (idempotente) caso o 1 não tenha rodado.
//   3. process 'exit': SIGKILL síncrono em qualquer filho ainda vivo.
//   4. SIGTERM/SIGINT/SIGHUP no main → app.quit() (cai no 1), com timeout.
//   5. Main morto por SIGKILL/crash: o watchdog do próprio serve
//      (HERMES_PARENT_PID, ver backend.ts) encerra o serve em ~2s.
let quitReady = false
let quitting = false

app.on('before-quit', (event) => {
  if (quitReady) return
  closeAllWs()
  if (!hasBackend()) {
    stopBackend() // marca shuttingDown — nenhum spawn novo durante o quit
    quitReady = true
    return
  }
  event.preventDefault()
  if (quitting) return
  quitting = true
  void stopBackendGracefully(2500).finally(() => {
    quitReady = true
    app.quit()
  })
})

app.on('will-quit', () => {
  closeAllWs()
  stopBackend()
})

process.on('exit', () => {
  stopBackend('SIGKILL')
})

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => {
    // Fallback se o quit gracioso travar: mata o grupo e sai mesmo assim.
    setTimeout(() => {
      stopBackend('SIGKILL')
      process.exit(0)
    }, 5000).unref()
    if (app.isReady()) app.quit()
    else {
      stopBackend('SIGKILL')
      process.exit(0)
    }
  })
}
