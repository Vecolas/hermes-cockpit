/// <reference types="vite/client" />

export interface BackendInfo {
  baseUrl: string
  wsUrl: string
  token: string
  pid?: number
}

export interface HermesBridge {
  backend(): Promise<BackendInfo>
  api(path: string): Promise<unknown>
}

declare global {
  interface Window {
    hermes?: HermesBridge
  }
}
