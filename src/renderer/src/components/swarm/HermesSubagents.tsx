import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseGatewayEvent } from '../../lib/gateway'
import type { HermesRpc } from '../../lib/rpc'
import { errMsg, fmtDuration, useNow } from '../../lib/swarm'
import { toast } from '../../lib/toast'
import { useViewActive } from '../layout/views'
import { Btn, ConfirmButton, SkeletonRows } from './ui'

// Subagents nativos do Hermes (delegate_tool) via RPC do gateway:
//   delegation.status {}             → árvore viva global do processo serve + pausa/limites
//   delegation.pause {paused}        → bloqueia/libera NOVOS spawns
//   subagent.tail/steer/interrupt    → exigem {session_id (runtime, dono), subagent_id}
//   spawn_tree.list/load             → snapshots salvos (histórico)
// Eventos `subagent.*` (frame `event` com session_id) dão o session_id dono e
// atualizam o último tool/texto sem esperar o polling.

interface ActiveSub {
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

interface DelegationStatus {
  active: ActiveSub[]
  paused: boolean
  max_spawn_depth: number
  max_concurrent_children: number
}

interface TreeEntry {
  path: string
  session_id?: string | null
  started_at?: number | null
  finished_at?: number | null
  label?: string
  count?: number
}

interface LiveInfo {
  sessionId?: string
  lastTool?: string
  lastText?: string
  status?: string
  goal?: string
  at: number
}

const TERMINAL = new Set(['completed', 'failed', 'error', 'timeout', 'interrupted'])

function statusTone(s?: string | null): string {
  if (!s || s === 'running') return 'bg-phos'
  if (s === 'queued') return 'bg-edge2'
  if (s === 'completed') return 'bg-cyanic'
  if (s === 'interrupted') return 'bg-faint'
  return 'bg-alert'
}

function secs(n?: number | null): number | null {
  if (n == null) return null
  return n > 1e12 ? n : n * 1000 // backend usa epoch em segundos
}

export function HermesSubagents({ rpc }: { rpc: HermesRpc | null }) {
  const [open, setOpen] = useState(() => Boolean(rpc?.isOpen()))
  const [st, setSt] = useState<DelegationStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState<string | null>(null)
  const live = useRef(new Map<string, LiveInfo>())
  const [liveTick, setLiveTick] = useState(0)
  const now = useNow(1000, Boolean(st?.active.length))
  // view escondida (keep-alive): pausa o polling
  const viewActive = useViewActive()

  // estado de conexão por polling (onState do HermesRpc é único e pertence ao App)
  useEffect(() => {
    const iv = setInterval(() => setOpen(Boolean(rpc?.isOpen())), 1000)
    setOpen(Boolean(rpc?.isOpen()))
    return () => clearInterval(iv)
  }, [rpc])

  const load = useCallback(async () => {
    if (!rpc || !rpc.isOpen()) return
    try {
      const r = await rpc.call<DelegationStatus>('delegation.status', {})
      setSt({
        active: Array.isArray(r?.active) ? r.active : [],
        paused: Boolean(r?.paused),
        max_spawn_depth: r?.max_spawn_depth ?? 0,
        max_concurrent_children: r?.max_concurrent_children ?? 0,
      })
      setErr(null)
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [rpc])

  useEffect(() => {
    if (!open || !viewActive) return
    void load()
    const iv = setInterval(() => void load(), 3000)
    return () => clearInterval(iv)
  }, [open, load, viewActive])

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
      const prev = live.current.get(id)
      live.current.set(id, {
        sessionId: ev.session_id ?? prev?.sessionId,
        lastTool: typeof p.tool_name === 'string' ? p.tool_name : prev?.lastTool,
        lastText: typeof p.text === 'string' && p.text.trim() ? p.text : prev?.lastText,
        status: typeof p.status === 'string' ? p.status : prev?.status,
        goal: typeof p.goal === 'string' ? p.goal : prev?.goal,
        at: Date.now(),
      })
      setLiveTick((n) => n + 1)
      if (t) clearTimeout(t)
      t = setTimeout(() => void load(), 250)
    })
    return () => {
      off()
      if (t) clearTimeout(t)
    }
  }, [rpc, load])

  const active = useMemo(() => st?.active ?? [], [st])
  const tree = useMemo(() => {
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
  }, [active])

  const selected = active.find((a) => a.subagent_id === sel) ?? null
  void liveTick

  if (!rpc || !open) {
    return (
      <div className="hc-fade-in p-8 text-[11px] text-dim">
        <div className="label mb-2">subagents hermes</div>
        gateway desconectado — a árvore de delegação aparece quando o WS do serve estiver aberto.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[360px] shrink-0 flex-col border-r border-edge">
        <div className="flex items-center gap-2 border-b border-edge px-4 py-2">
          <span className="label">delegação ao vivo</span>
          {st && (
            <span className="text-[10px] text-faint">
              prof. máx {st.max_spawn_depth} · {st.max_concurrent_children} simultâneos
            </span>
          )}
          {st && (
            <Btn
              className="ml-auto"
              tone={st.paused ? 'primary' : 'default'}
              title="bloqueia/libera NOVOS spawns (os ativos continuam)"
              onClick={async () => {
                try {
                  const r = await rpc.call<{ paused: boolean }>('delegation.pause', { paused: !st.paused })
                  setSt({ ...st, paused: Boolean(r?.paused) })
                } catch (e) {
                  toast({ title: 'delegation.pause falhou', detail: errMsg(e), tone: 'error' })
                }
              }}
            >
              {st.paused ? 'spawns pausados · retomar' : 'pausar spawns'}
            </Btn>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {loading && !st ? (
            <SkeletonRows n={3} className="px-2" />
          ) : err && !st ? (
            <div className="px-2 text-[11px] text-alert">delegation.status: {err}</div>
          ) : !tree.length ? (
            <div className="px-2 text-[11px] text-faint">nenhum subagent rodando neste serve</div>
          ) : (
            tree.map(({ a, lvl }) => {
              const info = live.current.get(a.subagent_id)
              const status = info?.status ?? a.status ?? 'running'
              const start = secs(a.started_at)
              return (
                <button
                  key={a.subagent_id}
                  type="button"
                  onClick={() => setSel(a.subagent_id)}
                  style={{ paddingLeft: 8 + lvl * 14 }}
                  className={`hc-rise mb-0.5 flex w-full min-w-0 flex-col rounded py-1.5 pr-2 text-left transition-colors ${
                    sel === a.subagent_id ? 'bg-panel2' : 'hover:bg-panel2/60'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {lvl > 0 && <span className="text-faint">└</span>}
                    <span
                      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${statusTone(status)} ${
                        TERMINAL.has(status) ? '' : 'hc-pulse-dot'
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink">{a.goal || info?.goal || a.subagent_id}</span>
                    <span className="shrink-0 text-[10px] text-faint">{start ? fmtDuration(now - start) : ''}</span>
                  </span>
                  <span className="ml-3.5 flex min-w-0 gap-2 text-[10px] text-faint">
                    <span>{status}</span>
                    {a.model && <span className="truncate">{a.model}</span>}
                    {a.tool_count != null && <span>{a.tool_count} tools</span>}
                    {(info?.lastTool ?? a.last_tool) && <span className="truncate text-cyanic/80">→ {info?.lastTool ?? a.last_tool}</span>}
                  </span>
                </button>
              )
            })
          )}
          {err && st && <div className="px-2 pt-2 text-[10.5px] text-alert">última atualização falhou: {err}</div>}
        </div>
        <SpawnTrees rpc={rpc} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <SubagentDetail
            key={selected.subagent_id}
            rpc={rpc}
            sub={selected}
            sessionId={live.current.get(selected.subagent_id)?.sessionId ?? selected.owner_agent_session_id ?? null}
            lastText={live.current.get(selected.subagent_id)?.lastText}
          />
        ) : (
          <div className="p-8 text-[11px] text-faint">
            {tree.length ? 'selecione um subagent para ver o transcript ao vivo' : 'quando um bot delegar, a árvore aparece aqui'}
          </div>
        )}
      </div>
    </div>
  )
}

function SubagentDetail({
  rpc,
  sub,
  sessionId,
  lastText,
}: {
  rpc: HermesRpc
  sub: ActiveSub
  sessionId: string | null
  lastText?: string
}) {
  const [tail, setTail] = useState<{ text: string; available: boolean; truncated: boolean } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [steer, setSteer] = useState('')
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLPreElement>(null)
  const viewActive = useViewActive()

  useEffect(() => {
    if (!sessionId || !viewActive) return
    let cancel = false
    const pull = async () => {
      try {
        const r = await rpc.call<{ text?: string; available?: boolean; truncated?: boolean }>('subagent.tail', {
          session_id: sessionId,
          subagent_id: sub.subagent_id,
        })
        if (cancel) return
        setTail({ text: r?.text ?? '', available: Boolean(r?.available), truncated: Boolean(r?.truncated) })
        setErr(null)
      } catch (e) {
        if (!cancel) setErr(errMsg(e))
      }
    }
    void pull()
    const iv = setInterval(() => void pull(), 2000)
    return () => {
      cancel = true
      clearInterval(iv)
    }
  }, [rpc, sessionId, sub.subagent_id, viewActive])

  useEffect(() => {
    const el = box.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight
  }, [tail?.text])

  const noOwner = !sessionId
  const doSteer = async () => {
    const text = steer.trim()
    if (!text || !sessionId) return
    setBusy(true)
    try {
      const r = await rpc.call<{ status: string }>('subagent.steer', { session_id: sessionId, subagent_id: sub.subagent_id, text })
      toast({
        title: r?.status === 'queued' ? 'Direcionamento enfileirado' : `Direcionamento ${r?.status ?? 'enviado'}`,
        detail: r?.status === 'queued' ? 'entregue no próximo lote de ferramentas' : undefined,
        tone: r?.status === 'rejected' ? 'warn' : 'ok',
      })
      if (r?.status !== 'rejected') setSteer('')
    } catch (e) {
      toast({ title: 'steer falhou', detail: errMsg(e), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hc-fade-in flex min-h-0 flex-1 flex-col">
      <div className="border-b border-edge px-5 py-3">
        <div className="text-[12.5px] text-ink">{sub.goal || sub.subagent_id}</div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[10.5px] text-faint">
          <span>{sub.subagent_id}</span>
          {sub.model && <span>{sub.model}</span>}
          {sub.depth != null && <span>profundidade {sub.depth}</span>}
          {sessionId && <span title="sessão dona">sessão {sessionId.slice(0, 10)}</span>}
        </div>
      </div>
      <pre
        ref={box}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-5 py-3 text-[11.5px] leading-relaxed text-ink/85"
      >
        {noOwner
          ? 'sessão dona desconhecida — o transcript fica disponível depois do primeiro evento subagent.* recebido por este cockpit (subagents de sessões abertas em outro cliente não são controláveis daqui).'
          : err
            ? `subagent.tail: ${err}`
            : !tail
              ? 'carregando…'
              : tail.available
                ? `${tail.truncated ? '… (últimos 16KB)\n' : ''}${tail.text}`
                : lastText || 'sem transcript ao vivo ainda'}
      </pre>
      <div className="flex items-center gap-2 border-t border-edge px-5 py-2.5">
        <input
          value={steer}
          onChange={(e) => setSteer(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void doSteer()}
          disabled={noOwner || busy}
          placeholder={noOwner ? 'steer indisponível (sessão dona desconhecida)' : 'direcionar o subagent (steer)…'}
          className="min-w-0 flex-1 rounded border border-edge2 bg-void px-2 py-1.5 text-[11.5px] text-ink outline-none placeholder:text-faint focus:border-amber/60 disabled:opacity-50"
        />
        <Btn onClick={() => void doSteer()} disabled={noOwner || busy || !steer.trim()}>
          enviar
        </Btn>
        <ConfirmButton
          label="interromper"
          confirmLabel="interromper mesmo?"
          disabled={noOwner}
          onConfirm={async () => {
            try {
              const r = await rpc.call<{ found: boolean }>('subagent.interrupt', {
                session_id: sessionId,
                subagent_id: sub.subagent_id,
              })
              toast({ title: r?.found ? 'Subagent interrompido' : 'Subagent já tinha terminado', tone: r?.found ? 'ok' : 'info' })
            } catch (e) {
              toast({ title: 'interrupt falhou', detail: errMsg(e), tone: 'error' })
            }
          }}
        />
      </div>
    </div>
  )
}

function SpawnTrees({ rpc }: { rpc: HermesRpc }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<TreeEntry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ path: string; subs: Record<string, unknown>[] } | null>(null)

  useEffect(() => {
    if (!open) return
    let cancel = false
    rpc.call<{ entries: TreeEntry[] }>('spawn_tree.list', { cross_session: true, limit: 25 }).then(
      (r) => !cancel && setRows(Array.isArray(r?.entries) ? r.entries : []),
      (e) => !cancel && setErr(errMsg(e)),
    )
    return () => {
      cancel = true
    }
  }, [open, rpc])

  return (
    <div className="border-t border-edge">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="label flex w-full items-center gap-2 px-4 py-2 text-left hover:text-dim"
      >
        {open ? '▾' : '▸'} histórico de árvores
      </button>
      {open && (
        <div className="hc-fade-in max-h-64 overflow-y-auto px-2 pb-2">
          {err ? (
            <div className="px-2 text-[11px] text-alert">{err}</div>
          ) : !rows ? (
            <SkeletonRows n={2} className="px-2" />
          ) : !rows.length ? (
            <div className="px-2 text-[11px] text-faint">nenhum snapshot salvo</div>
          ) : (
            rows.map((r) => (
              <div key={r.path}>
                <button
                  type="button"
                  onClick={async () => {
                    if (detail?.path === r.path) return setDetail(null)
                    try {
                      const d = await rpc.call<{ subagents?: Record<string, unknown>[] }>('spawn_tree.load', { path: r.path })
                      setDetail({ path: r.path, subs: Array.isArray(d?.subagents) ? d.subagents : [] })
                    } catch (e) {
                      toast({ title: 'spawn_tree.load falhou', detail: errMsg(e), tone: 'error' })
                    }
                  }}
                  className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-[11px] text-dim hover:bg-panel2/60 hover:text-ink"
                >
                  <span className="min-w-0 flex-1 truncate">{r.label || r.path.split('/').pop()}</span>
                  <span className="shrink-0 text-[10px] text-faint">{r.count ?? 0}</span>
                  <span className="shrink-0 text-[10px] text-faint">
                    {r.started_at ? new Date(secs(r.started_at) ?? 0).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : ''}
                  </span>
                </button>
                {detail?.path === r.path && (
                  <ul className="hc-fade-in mb-1 ml-4 border-l border-edge pl-2">
                    {detail.subs.length ? (
                      detail.subs.map((s, i) => (
                        <li key={i} className="py-0.5 text-[10.5px] text-faint">
                          <span className="text-dim">{String(s.goal ?? s.subagent_id ?? `#${i + 1}`).slice(0, 120)}</span>
                          {s.status != null && <span> · {String(s.status)}</span>}
                        </li>
                      ))
                    ) : (
                      <li className="text-[10.5px] text-faint">snapshot vazio</li>
                    )}
                  </ul>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
