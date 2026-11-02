// Subagents nativos do Hermes (delegate_tool) via RPC do gateway — estado vivo
// compartilhado entre a masterview (Comando) e a aba "Subagents Hermes". Um
// único dono (SwarmView) chama useHermesDelegation e repassa o resultado: nada
// de dois pollers nem duas cópias do mesmo estado.
//
//   delegation.status {}             → árvore viva global do processo serve + pausa/limites
//   delegation.pause {paused}        → bloqueia/libera NOVOS spawns
//   subagent.tail/steer/interrupt    → exigem {session_id (runtime, dono), subagent_id}
//   spawn_tree.list/load             → snapshots salvos (histórico)
// Eventos `subagent.*` (frame `event` com session_id) dão o session_id dono e
// atualizam o último tool/texto sem esperar o polling.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseGatewayEvent } from './gateway'
import type { HermesRpc } from './rpc'
import { errMsg } from './swarm'

export interface ActiveSub {
  subagent_id: string
  parent_id?: string | null
  depth?: number | null
  goal?: string | null
  model?: string | null
  started_at?: number | null
  status?: string | null
  tool_count?: number | null
  owner_agent_session_id?: string | null
  last_tool?: string | null
  [k: string]: unknown
}

export interface DelegationStatus {
  active: ActiveSub[]
  paused: boolean
  max_spawn_depth: number
  max_concurrent_children: number
}

export interface LiveInfo {
  sessionId?: string
  lastTool?: string
  lastText?: string
  status?: string
  goal?: string
  at: number
}

export const SUB_TERMINAL = new Set(['completed', 'failed', 'error', 'timeout', 'interrupted'])

/** classe de fundo por status de subagent (mesma semântica de STATUS_TONE das runs) */
export function subTone(s?: string | null): string {
  if (!s || s === 'running') return 'bg-phos'
  if (s === 'queued') return 'bg-edge2'
  if (s === 'completed') return 'bg-cyanic'
  if (s === 'interrupted') return 'bg-faint'
  return 'bg-alert'
}

/** rótulo PT-BR do status de subagent (vocabulário igual ao das runs) */
export function subLabel(s?: string | null): string {
  switch (s ?? 'running') {
    case 'running':
      return 'executando'
    case 'queued':
      return 'na fila'
    case 'completed':
      return 'concluída'
    case 'interrupted':
      return 'interrompida'
    case 'timeout':
      return 'tempo esgotado'
    default:
      return 'falhou'
  }
}

/** backend usa epoch em segundos; aceita ms também */
export function epochMs(n?: number | null): number | null {
  if (n == null) return null
  return n > 1e12 ? n : n * 1000
}

export interface HermesDelegation {
  /** rpc existe e o WS está aberto */
  online: boolean
  status: DelegationStatus | null
  error: string | null
  loading: boolean
  /** info viva por subagent_id (eventos subagent.*); muda de identidade a cada evento */
  live: ReadonlyMap<string, LiveInfo>
  /** árvore achatada (pai antes dos filhos) com nível */
  tree: { a: ActiveSub; lvl: number }[]
  reload: () => Promise<void>
  setPaused: (paused: boolean) => Promise<void>
}

/**
 * Estado vivo da delegação do Hermes. `enabled=false` (view escondida) pausa o
 * polling; os eventos continuam alimentando `live`.
 */
export function useHermesDelegation(rpc: HermesRpc | null, enabled: boolean): HermesDelegation {
  const [online, setOnline] = useState(() => Boolean(rpc?.isOpen()))
  const [status, setStatus] = useState<DelegationStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const liveRef = useRef(new Map<string, LiveInfo>())
  const [live, setLive] = useState<ReadonlyMap<string, LiveInfo>>(() => new Map())

  // estado de conexão por polling (onState do HermesRpc é único e pertence ao App)
  useEffect(() => {
    const tick = () => setOnline(Boolean(rpc?.isOpen()))
    tick()
    const iv = setInterval(tick, 1000)
    return () => clearInterval(iv)
  }, [rpc])

  const reload = useCallback(async () => {
    if (!rpc || !rpc.isOpen()) return
    try {
      const r = await rpc.call<DelegationStatus>('delegation.status', {})
      setStatus({
        active: Array.isArray(r?.active) ? r.active : [],
        paused: Boolean(r?.paused),
        max_spawn_depth: r?.max_spawn_depth ?? 0,
        max_concurrent_children: r?.max_concurrent_children ?? 0,
      })
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [rpc])

  useEffect(() => {
    if (!online || !enabled) return
    void reload()
    const iv = setInterval(() => void reload(), 3000)
    return () => clearInterval(iv)
  }, [online, enabled, reload])

  // eventos subagent.* ao vivo
  useEffect(() => {
    if (!rpc) return
    let t: ReturnType<typeof setTimeout> | null = null
    const off = rpc.subscribe((method, params) => {
      const ev = parseGatewayEvent(method, params)
      if (!ev || !ev.type.startsWith('subagent.')) return
      const p = ev.payload ?? {}
      const id = typeof p.subagent_id === 'string' ? p.subagent_id : null
      if (!id) return
      const prev = liveRef.current.get(id)
      liveRef.current.set(id, {
        sessionId: ev.session_id ?? prev?.sessionId,
        lastTool: typeof p.tool_name === 'string' ? p.tool_name : prev?.lastTool,
        lastText: typeof p.text === 'string' && p.text.trim() ? p.text : prev?.lastText,
        status: typeof p.status === 'string' ? p.status : prev?.status,
        goal: typeof p.goal === 'string' ? p.goal : prev?.goal,
        at: Date.now(),
      })
      setLive(new Map(liveRef.current))
      if (t) clearTimeout(t)
      t = setTimeout(() => void reload(), 250)
    })
    return () => {
      off()
      if (t) clearTimeout(t)
    }
  }, [rpc, reload])

  const setPaused = useCallback(
    async (paused: boolean) => {
      if (!rpc) return
      const r = await rpc.call<{ paused: boolean }>('delegation.pause', { paused })
      setStatus((s) => (s ? { ...s, paused: Boolean(r?.paused) } : s))
    },
    [rpc],
  )

  const tree = useMemo(() => flattenTree(status?.active ?? []), [status])

  return { online: Boolean(rpc) && online, status, error, loading, live, tree, reload, setPaused }
}

function flattenTree(active: ActiveSub[]): { a: ActiveSub; lvl: number }[] {
  const ids = new Set(active.map((a) => a.subagent_id))
  const kids = new Map<string, ActiveSub[]>()
  const roots: ActiveSub[] = []
  for (const a of active) {
    if (a.parent_id && ids.has(a.parent_id)) {
      const arr = kids.get(a.parent_id) ?? []
      arr.push(a)
      kids.set(a.parent_id, arr)
    } else roots.push(a)
  }
  const flat: { a: ActiveSub; lvl: number }[] = []
  const walk = (a: ActiveSub, lvl: number) => {
    flat.push({ a, lvl })
    for (const c of kids.get(a.subagent_id) ?? []) walk(c, lvl + 1)
  }
  roots.forEach((r) => walk(r, 0))
  return flat
}
