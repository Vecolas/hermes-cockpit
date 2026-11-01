import { useSyncExternalStore } from 'react'
import { invoke } from './ipc'
import { toast } from './toast'

// Auto mode global do cockpit — liga "em tudo" de uma vez:
// - swarm: modo de permissão padrão das novas runs do Claude Code
//   (auto = --permission-mode auto; manual = card no cockpit para tudo fora do worktree)
// - Hermes: approvals.mode (smart = guardian decide sozinho; manual = card)
//   aplicado pelo ChatPane na sessão ativa via evento 'hc:approval-mode'.
// Per-chat e per-run continuam ajustáveis (chip no composer / select no form).

export type HermesApproval = 'manual' | 'smart' | 'off'
export type SwarmPerm = 'manual' | 'auto' | 'acceptEdits' | 'bypass'

export const HERMES_APPROVAL_LABEL: Record<HermesApproval, string> = {
  manual: 'manual',
  smart: 'auto',
  off: 'yolo',
}
export const SWARM_PERM_LABEL: Record<SwarmPerm, string> = {
  manual: 'manual (aprovar no cockpit)',
  auto: 'auto (classificador)',
  acceptEdits: 'aceitar edições',
  bypass: 'bypass (sem aprovação)',
}

const KEY = 'hermes-cockpit.auto-mode'
let on = (() => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
})()
const subs = new Set<() => void>()

export function useAutoMode(): boolean {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    () => on,
  )
}

export async function setAutoMode(next: boolean): Promise<void> {
  on = next
  try {
    localStorage.setItem(KEY, next ? '1' : '0')
  } catch {
    /* sem storage */
  }
  subs.forEach((f) => f())
  window.dispatchEvent(new CustomEvent<HermesApproval>('hc:approval-mode', { detail: next ? 'smart' : 'manual' }))
  try {
    await invoke('swarm:setConfig', { defaultPermissionMode: next ? 'auto' : 'manual' })
  } catch {
    /* swarm não instalado / navegador: segue só com o Hermes */
  }
  toast({
    title: next ? 'Auto mode ligado' : 'Auto mode desligado',
    detail: next ? 'Hermes: aprovação smart · Swarm: --permission-mode auto' : 'Hermes: aprovação manual · Swarm: aprovação no cockpit',
    tone: next ? 'ok' : 'info',
  })
}
