import { useEffect, useRef, useState } from 'react'
import { hasMain, invoke, onMain } from '../../lib/ipc'

// Contadores do selo da aba Swarm: aprovações pendentes (swarm:approvals) e
// runs ativas (swarm:list → status running|queued|waiting_approval). Tolerante:
// sem main (navegador) ou domínio ainda sem handler → null, sem selo, sem erro.
// Recarrega no evento swarm:changed (debounce) e a cada 15s como rede de segurança.

export interface SwarmBadge {
  approvals: number | null
  active: number | null
}

const ACTIVE = new Set(['running', 'queued', 'waiting_approval'])

export function useSwarmBadge(): SwarmBadge {
  const [state, setState] = useState<SwarmBadge>({ approvals: null, active: null })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!hasMain()) return
    let alive = true
    const load = async () => {
      const [ap, runs] = await Promise.allSettled([
        invoke<unknown>('swarm:approvals'),
        invoke<unknown>('swarm:list', { limit: 100 }),
      ])
      if (!alive) return
      const approvals =
        ap.status === 'fulfilled' && Array.isArray(ap.value)
          ? ap.value.filter((a) => !a || typeof a !== 'object' || (a as { status?: unknown }).status === undefined || (a as { status?: unknown }).status === 'pending').length
          : null
      const active =
        runs.status === 'fulfilled' && Array.isArray(runs.value)
          ? runs.value.filter((r) => r && typeof r === 'object' && ACTIVE.has(String((r as { status?: unknown }).status))).length
          : null
      setState((s) => (s.approvals === approvals && s.active === active ? s : { approvals, active }))
    }
    void load()
    const iv = setInterval(() => void load(), 15_000)
    const off = onMain('swarm:changed', () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void load(), 200)
    })
    return () => {
      alive = false
      clearInterval(iv)
      off()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return state
}
