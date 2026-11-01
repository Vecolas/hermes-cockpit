import { contextBridge, ipcRenderer } from 'electron'

const bridge = {
  backend: () => ipcRenderer.invoke('hermes:backend'),
  api: (path: string) => ipcRenderer.invoke('hermes:api', path),
}

contextBridge.exposeInMainWorld('hermes', bridge)

export type HermesBridge = typeof bridge
