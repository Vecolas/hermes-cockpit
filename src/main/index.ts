import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { apiFetch, ensureBackend, stopBackend } from './backend'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b0d10',
    title: 'Hermes Cockpit',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  ipcMain.handle('hermes:backend', () => ensureBackend())
  ipcMain.handle('hermes:api', (_event, path: string) => apiFetch(path))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// O serve morre com o app — mesmo contrato de lifecycle do desktop oficial.
app.on('will-quit', () => stopBackend())
