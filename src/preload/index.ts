import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

// Espelho dos tipos de src/main/wsproxy.ts e src/renderer/src/env.d.ts —
// o preload é empacotado à parte e não importa do main nem do renderer.
type WsProxyState = 'connecting' | 'open' | 'error' | 'closed'
interface WsProxyStateInfo {
  state: WsProxyState
  code?: number
  reason?: string
  message?: string
}
interface WsOpenResult {
  ok: boolean
  error?: string
}
type WsData = string | ArrayBuffer

const ws = {
  open: (id: string, path?: string): Promise<WsOpenResult> => ipcRenderer.invoke('hermes:ws:open', id, path),
  send: (id: string, data: string | ArrayBuffer | Uint8Array): void => ipcRenderer.send('hermes:ws:send', id, data),
  close: (id: string, code?: number, reason?: string): void => ipcRenderer.send('hermes:ws:close', id, code, reason),
  onFrame: (fn: (id: string, data: WsData) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, id: string, data: WsData) => fn(id, data)
    ipcRenderer.on('hermes:ws:frame', listener)
    return () => {
      ipcRenderer.removeListener('hermes:ws:frame', listener)
    }
  },
  onState: (fn: (id: string, info: WsProxyStateInfo) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, id: string, info: WsProxyStateInfo) => fn(id, info)
    ipcRenderer.on('hermes:ws:state', listener)
    return () => {
      ipcRenderer.removeListener('hermes:ws:state', listener)
    }
  },
}

const bridge = {
  backend: () => ipcRenderer.invoke('hermes:backend'),
  api: (path: string) => ipcRenderer.invoke('hermes:api', path),
  ws,
}

contextBridge.exposeInMainWorld('hermes', bridge)

export type HermesBridge = typeof bridge
