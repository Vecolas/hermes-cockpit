import { useEffect, useMemo, useState } from 'react'
import type { HermesRpc } from '../../lib/rpc'
import {
  fmtCost,
  fmtDuration,
  isActive,
  repoName,
  runElapsedMs,
  runHandle,
  STATUS_TONE,
  useNow,
  useSwarm,
  type RunMeta,
} from '../../lib/swarm'
import { SwarmTree } from './SwarmTree'
import { HermesSubagents } from './HermesSubagents'
import { RunDetail } from './RunDetail'
import { SpawnForm } from './SpawnForm'
import { SwarmApprovalCard } from './SwarmApproval'
import { Btn, RunBar, StatusDot, SwarmGate } from './ui'

// Visão completa do swarm (área central): runs de Claude Code + subagents do Hermes.
// CONTRATO: nome do export e props são fixos (App/registry já montam assim).

type Filter = 'active' | 'done' | 'error' | 'all'
type Tab = 'tree' | 'claude' | 'hermes'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'active', label: 'ativas' },
  { id: 'done', label: 'concluídas' },
  { id: 'error', label: 'erro' },
  { id: 'all', label: 'todas' },
]

const TAB_KEY = 'hc.swarm.tab'
const SEL_KEY = 'hc.swarm.sel'

function readLS(k: string): string | null {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function writeLS(k: string, v: string | null): void {
  try {
    if (v == null) localStorage.removeItem(k)
    else localStorage.setItem(k, v)
  } catch {
    /* ignore */
  }
}

function matches(r: RunMeta, f: Filter): boolean {
  if (f === 'all') return true
  if (f === 'active') return isActive(r.status)
  if (f === 'done') return r.status === 'done'
  return r.status === 'error' || r.status === 'cancelled'
}

interface Group {
  key: string
  groupId?: string
  runs: RunMeta[]
}

function groupRuns(runs: RunMeta[]): Group[] {
  const out: Group[] = []
  const byId = new Map<string, Group>()
  for (const r of runs) {
    if (r.groupId) {
      let g = byId.get(r.groupId)
      if (!g) {
        g = { key: r.groupId, groupId: r.groupId, runs: [] }
        byId.set(r.groupId, g)
        out.push(g)
      }
      g.runs.push(r)
    } else out.push({ key: r.id, runs: [r] })
  }
  return out
}

export function SwarmView({ rpc }: { rpc: HermesRpc | null }) {
  const s = useSwarm()
  const [tab, setTab] = useState<Tab>(() => {
    const t = readLS(TAB_KEY)
    return t === 'hermes' || t === 'claude' ? t : 'tree'
  })
  const [filter, setFilter] = useState<Filter>('all')
  const [sel, setSel] = useState<string | null>(() => readLS(SEL_KEY))
  const [creating, setCreating] = useState(false)
  const anyActive = s.runs.some((r) => isActive(r.status))
  const now = useNow(1000, anyActive)

  useEffect(() => writeLS(TAB_KEY, tab), [tab])
  useEffect(() => writeLS(SEL_KEY, sel), [sel])

  // ⌘K "Nova tarefa Claude Code": o App troca para esta view e dispara o evento.
  useEffect(() => {
    const onNewTask = () => {
      setTab('claude')
      setCreating(true)
    }
    window.addEventListener('hc:swarm-new-task', onNewTask)
    return () => window.removeEventListener('hc:swarm-new-task', onNewTask)
  }, [])

  // seleção padrão: primeira run ativa, senão a mais recente
  useEffect(() => {
    if (!s.runs.length) return
    if (sel && s.runs.some((r) => r.id === sel)) return
    setSel((s.runs.find((r) => isActive(r.status)) ?? s.runs[0]).id)
  }, [s.runs, sel])

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { active: 0, done: 0, error: 0, all: s.runs.length }
    for (const r of s.runs) {
      if (matches(r, 'active')) c.active++
      else if (matches(r, 'done')) c.done++
      else if (matches(r, 'error')) c.error++
    }
    return c
  }, [s.runs])

  const groups = useMemo(() => groupRuns(s.runs.filter((r) => matches(r, filter))), [s.runs, filter])
  const selected = s.runs.find((r) => r.id === sel) ?? null
  const otherApprovals = s.approvals.filter((a) => a.runId !== sel)

  return (
    <div className="flex h-full min-h-0 flex-col bg-void">
      {/* abas */}
      <div
        className="flex items-center gap-1 border-b border-edge px-4 py-2"
        role="tablist"
        aria-label="Swarm"
        onKeyDown={(e) => {
          // ←/→/Home/End movem a aba selecionada (padrão de ui/Tabs)
          const ids = (['tree', 'claude', 'hermes'] as Tab[])
          const i = ids.indexOf(tab)
          let n = -1
          if (e.key === 'ArrowRight') n = (i + 1) % ids.length
          else if (e.key === 'ArrowLeft') n = (i - 1 + ids.length) % ids.length
          else if (e.key === 'Home') n = 0
          else if (e.key === 'End') n = ids.length - 1
          if (n < 0) return
          e.preventDefault()
          setTab(ids[n])
          e.currentTarget.querySelector<HTMLElement>(`[data-tab-id="${ids[n]}"]`)?.focus()
        }}
      >
        {(
          [
            ['tree', 'Árvore ao vivo'],
            ['claude', 'Claude Code'],
            ['hermes', 'Subagents Hermes'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-tab-id={id}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            className={`relative rounded px-3 py-1 text-[11px] uppercase tracking-[0.14em] transition-colors ${
              tab === id ? 'bg-panel2 text-ink' : 'text-faint hover:text-dim'
            }`}
          >
            {label}
            {(id === 'claude' || id === 'tree') && s.approvals.length > 0 && (
              <span className="ml-2 rounded-full bg-amber px-1.5 text-[9.5px] font-semibold text-void">{s.approvals.length}</span>
            )}
          </button>
        ))}
        {tab === 'claude' && s.status?.installed && (
          <span className="ml-auto text-[10px] text-faint">
            {s.status.claudeVersion ? `claude ${s.status.claudeVersion}` : 'claude ?'}
            {s.status.profilesRegistered.length > 0 && ` · bots: ${s.status.profilesRegistered.join(', ')}`}
          </span>
        )}
      </div>

      {tab === 'hermes' ? (
        <HermesSubagents rpc={rpc} />
      ) : tab === 'tree' ? (
        <SwarmGate s={s}>
          <div className="relative min-h-0 flex-1">
            <SwarmTree
              runs={s.runs}
              approvals={s.approvals}
              onOpen={(id) => {
                setSel(id)
                setTab('claude')
              }}
            />
            <div className="absolute right-4 top-3">
              <Btn tone="primary" onClick={() => { setTab('claude'); setCreating(true) }}>
                + Nova tarefa
              </Btn>
            </div>
          </div>
        </SwarmGate>
      ) : (
        <SwarmGate s={s}>
          <div className="flex min-h-0 flex-1">
            {/* coluna esquerda */}
            <aside className="flex w-[320px] shrink-0 flex-col border-r border-edge bg-panel/40">
              <div className="space-y-2 border-b border-edge px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="label">execuções</span>
                  {s.error && s.phase !== 'unavailable' && (
                    <span className="truncate text-[10px] text-alert" title={s.error}>
                      ● {s.error}
                    </span>
                  )}
                  <Btn tone="primary" className="ml-auto" onClick={() => setCreating((v) => !v)}>
                    {creating ? 'fechar' : '+ Nova tarefa'}
                  </Btn>
                </div>
                <div className="flex gap-1">
                  {FILTERS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setFilter(f.id)}
                      className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] transition-colors ${
                        filter === f.id ? 'bg-panel2 text-ink' : 'text-faint hover:text-dim'
                      }`}
                    >
                      {f.label} <span className="text-faint">{counts[f.id]}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                {creating && (
                  <div className="mb-2">
                    <SpawnForm
                      onCancel={() => setCreating(false)}
                      onDone={(runs) => {
                        setCreating(false)
                        setFilter('all')
                        if (runs[0]) setSel(runs[0].id)
                      }}
                    />
                  </div>
                )}
                {otherApprovals.length > 0 && (
                  <div className="mb-2 space-y-1.5">
                    {otherApprovals.map((a) => (
                      <SwarmApprovalCard
                        key={a.id}
                        approval={a}
                        run={s.runs.find((r) => r.id === a.runId)}
                        compact
                        onSelectRun={setSel}
                      />
                    ))}
                  </div>
                )}
                {!groups.length ? (
                  <div className="px-2 py-3 text-[11px] text-faint">
                    {s.runs.length ? 'nada neste filtro' : 'nenhuma run ainda — crie uma em “Nova tarefa” ou peça a um bot (claude_spawn)'}
                  </div>
                ) : (
                  groups.map((g) =>
                    g.groupId && g.runs.length > 1 ? (
                      <div key={g.key} className="mb-2 rounded-md border border-edge/70 py-1">
                        <div className="label flex items-center gap-2 px-2 py-0.5 !text-[9.5px]">
                          grupo · {g.runs.length} runs
                          <span className="ml-auto normal-case tracking-normal text-faint">
                            {g.runs.filter((r) => r.status === 'done').length}/{g.runs.length} ok
                          </span>
                        </div>
                        {g.runs.map((r) => (
                          <RunRow key={r.id} r={r} now={now} selected={r.id === sel} onClick={() => setSel(r.id)} nested />
                        ))}
                      </div>
                    ) : (
                      <RunRow key={g.key} r={g.runs[0]} now={now} selected={g.runs[0].id === sel} onClick={() => setSel(g.runs[0].id)} />
                    ),
                  )
                )}
              </div>
            </aside>

            {/* centro */}
            <main className="flex min-w-0 flex-1 flex-col">
              {selected ? (
                <RunDetail key={selected.id} run={selected} approvals={s.approvals} onSelectRun={setSel} />
              ) : (
                <div className="hc-fade-in flex flex-1 items-center justify-center text-[11px] text-faint">
                  selecione uma run à esquerda
                </div>
              )}
            </main>
          </div>
        </SwarmGate>
      )}
    </div>
  )
}

function RunRow({
  r,
  now,
  selected,
  onClick,
  nested = false,
}: {
  r: RunMeta
  now: number
  selected: boolean
  onClick: () => void
  nested?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`hc-rise mb-0.5 block w-full min-w-0 rounded px-2 py-1.5 text-left transition-colors ${
        selected ? 'bg-panel2 ring-1 ring-edge2' : 'hover:bg-panel2/60'
      } ${nested ? 'pl-3' : ''}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <StatusDot status={r.status} />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink" title={r.task}>
          {r.title || r.task}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-faint">{fmtDuration(runElapsedMs(r, now))}</span>
      </span>
      <RunBar status={r.status} className="mt-1.5" />
      <span className="mt-1 flex min-w-0 gap-2 text-[10px] text-faint">
        <span className={STATUS_TONE[r.status].text}>{runHandle(r)}</span>
        <span className="truncate" title={r.repo}>
          {repoName(r.repo)}
          {r.branch ? ` ⎇ ${r.branch.replace(/^hermes\//, '')}` : ''}
        </span>
        <span className="ml-auto shrink-0">
          {r.numTurns != null ? `${r.numTurns}t · ` : ''}
          {r.costUsd != null ? fmtCost(r.costUsd) : ''}
        </span>
      </span>
    </button>
  )
}
