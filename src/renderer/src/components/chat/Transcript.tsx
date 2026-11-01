import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { STATUS_LABEL, fmtDuration, isActive, runElapsedMs, useNow, useSwarm, type RunMeta } from '../../lib/swarm'
import type { ChatItem } from '../../lib/chat-store'
import { CodeBlock, Markdown } from './Markdown'

interface Props {
  items: ChatItem[]
  verbose: boolean
  running: boolean
  status: string
  /** nome humano do bot (monograma/avatar das respostas) */
  botName?: string
  /** itens com índice ≥ baseline chegaram depois do load → animam a entrada */
  baseline?: number
  /** cards extras no fim do transcript (aprovações) */
  footer?: ReactNode
  empty?: ReactNode
}

export function Transcript({ items, verbose, running, status, botName, baseline = 0, footer, empty }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(0)
  const lastCount = useRef(items.length)

  // auto-scroll enquanto o usuário estiver no fim; conta novidades quando não está
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (stick.current) el.scrollTop = el.scrollHeight
    else if (items.length > lastCount.current) setUnseen((n) => n + (items.length - lastCount.current))
    lastCount.current = items.length
  })

  // troca de sessão (lista encolhe/zera): volta a grudar no fim
  useEffect(() => {
    if (items.length <= baseline) {
      stick.current = true
      setAtBottom(true)
      setUnseen(0)
    }
  }, [baseline, items.length])

  const toBottom = () => {
    const el = scroller.current
    if (!el) return
    stick.current = true
    setAtBottom(true)
    setUnseen(0)
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }

  const groups = groupItems(items)
  const monogram = (botName || '?').trim().charAt(0).toUpperCase() || '?'

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          stick.current = bottom
          if (bottom !== atBottom) setAtBottom(bottom)
          if (bottom) setUnseen(0)
        }}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
      >
        {items.length === 0 && !running && !footer && empty}
        <div className="flex flex-col gap-3">
          {groups.map((g, gi) => {
            const first = g.kind === 'tools' ? g.tools[0] : g.item
            const prev = gi > 0 ? lastOf(groups[gi - 1]) : null
            const sep = first.ts && (!prev?.ts || dayKey(prev.ts) !== dayKey(first.ts)) ? <DaySep key={`d-${first.id}`} ts={first.ts} /> : null
            const fresh = g.index >= baseline
            const node =
              g.kind === 'tools' ? (
                <ToolGroup key={g.id} tools={g.tools} verbose={verbose} fresh={fresh} />
              ) : (
                <Row key={g.item.id} item={g.item} verbose={verbose} fresh={fresh} monogram={monogram} botName={botName} />
              )
            return sep ? [sep, node] : node
          })}
          {running && <TurnIndicator status={status} />}
          {footer}
        </div>
      </div>
      {!atBottom && (
        <button
          onClick={toBottom}
          className="hc-glass hc-fade-in absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-edge2 px-3 py-1 text-[11px] text-ink shadow-lg hover:border-amber/60"
        >
          <span className="text-amber">↓</span>
          voltar ao fim
          {unseen > 0 && <span className="rounded-full bg-amber px-1.5 text-[10px] font-semibold text-void">{unseen}</span>}
        </button>
      )}
    </div>
  )
}

// ── agrupamento / datas ──────────────────────────────────────────────────────

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type Group = { kind: 'tools'; id: string; tools: ToolItem[]; index: number } | { kind: 'one'; item: ChatItem; index: number }

// tool calls consecutivas viram um bloco único (como no wireframe)
function groupItems(items: ChatItem[]): Group[] {
  const out: Group[] = []
  items.forEach((it, index) => {
    const last = out.at(-1)
    if (it.kind === 'tool') {
      if (last?.kind === 'tools') last.tools.push(it)
      else out.push({ kind: 'tools', id: `g-${it.id}`, tools: [it], index })
    } else out.push({ kind: 'one', item: it, index })
  })
  return out
}

function lastOf(g: Group): ChatItem {
  return g.kind === 'tools' ? g.tools[g.tools.length - 1] : g.item
}

function dayKey(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabel(ts: number): string {
  const d = new Date(ts * 1000)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  if (dayKey(ts) === dayKey(today.getTime() / 1000)) return 'Hoje'
  if (dayKey(ts) === dayKey(y.getTime() / 1000)) return 'Ontem'
  return d.toLocaleDateString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  })
}

function timeOf(ts?: number): string {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function fullTime(ts?: number): string | undefined {
  if (!ts) return undefined
  return new Date(ts * 1000).toLocaleString('pt-BR')
}

function DaySep({ ts }: { ts: number }) {
  return (
    <div className="flex items-center gap-3 py-1" role="separator">
      <span className="h-px flex-1 bg-edge" />
      <span className="label text-[9.5px]">{dayLabel(ts)}</span>
      <span className="h-px flex-1 bg-edge" />
    </div>
  )
}

function Stamp({ ts, side }: { ts?: number; side: 'left' | 'right' }) {
  if (!ts) return null
  return (
    <span
      title={fullTime(ts)}
      className={`pointer-events-none shrink-0 self-end pb-0.5 text-[10px] text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100 ${
        side === 'left' ? 'order-first' : ''
      }`}
    >
      {timeOf(ts)}
    </span>
  )
}

// ── linhas ───────────────────────────────────────────────────────────────────

function Row({
  item,
  verbose,
  fresh,
  monogram,
  botName,
}: {
  item: ChatItem
  verbose: boolean
  fresh: boolean
  monogram: string
  botName?: string
}) {
  const anim = fresh ? 'hc-rise' : ''
  switch (item.kind) {
    case 'user':
      return (
        <div className={`group flex justify-end gap-2 ${anim}`}>
          <Stamp ts={item.ts} side="left" />
          <div className="max-w-[78%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm border border-edge2 bg-panel2 px-3.5 py-2 text-ink">
            {item.text}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className={`group flex gap-2.5 ${anim}`}>
          <div
            title={botName}
            className={`mt-0.5 flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-md border text-[11px] font-semibold ${
              item.streaming ? 'border-amber/60 text-amber hc-glow-amber' : 'border-edge2 text-dim'
            } bg-panel`}
          >
            {monogram}
          </div>
          <div className="min-w-0 max-w-[92%] flex-1">
            {verbose && item.reasoning && (
              <details className="mb-1.5 text-[11.5px] text-faint" open={item.streaming && !item.text}>
                <summary className="label cursor-pointer select-none">raciocínio</summary>
                <div className="mt-1 whitespace-pre-wrap border-l border-edge2 pl-3 text-faint">{item.reasoning}</div>
              </details>
            )}
            {(item.text || item.streaming) && (
              <div className="break-words leading-relaxed text-ink/95">
                <Markdown text={item.text} />
                {item.streaming && <StreamCursor />}
              </div>
            )}
          </div>
          <Stamp ts={item.ts} side="right" />
        </div>
      )
    case 'note': {
      const cls =
        item.tone === 'error'
          ? 'border-alert/40 text-alert'
          : item.tone === 'warn'
            ? 'border-amber/40 text-amber'
            : 'border-edge text-dim'
      return (
        <div className={`group flex gap-2 ${anim}`}>
          <div className={`flex-1 rounded border px-3 py-1.5 text-[12px] ${cls}`}>{item.text}</div>
          <Stamp ts={item.ts} side="right" />
        </div>
      )
    }
    case 'slash':
      return (
        <div className={`rounded border border-edge bg-panel px-3 py-2 ${anim}`}>
          <div className="label mb-1 text-cyanic">{item.command}</div>
          {item.warning && <div className="mb-1 text-[11.5px] text-amber">{item.warning}</div>}
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-[12px] text-dim">{item.output || '(sem saída)'}</pre>
        </div>
      )
    default:
      return null
  }
}

/** Cursor de streaming: fade contínuo via Web Animations API (sem CSS novo). */
function StreamCursor() {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    // WAAPI ignora o bloco CSS de prefers-reduced-motion: cursor fica estático.
    if (!el || typeof el.animate !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const a = el.animate([{ opacity: 1 }, { opacity: 0.15 }], {
      duration: 650,
      iterations: Infinity,
      direction: 'alternate',
      easing: 'ease-in-out',
    })
    return () => a.cancel()
  }, [])
  return <span ref={ref} className="ml-0.5 inline-block h-[1.05em] w-[0.5em] rounded-[1px] bg-amber align-[-0.15em]" />
}

// ── tool calls ───────────────────────────────────────────────────────────────

function ToolGroup({ tools, verbose, fresh }: { tools: ToolItem[]; verbose: boolean; fresh: boolean }) {
  return (
    <div className={`ml-8 flex flex-col gap-1 ${fresh ? 'hc-rise' : ''}`}>
      {tools.map((t) => (
        <ToolCard key={t.id} tool={t} verbose={verbose} />
      ))}
    </div>
  )
}

function toolIcon(name: string): string {
  const n = name.toLowerCase()
  if (/terminal|shell|bash|exec|command|process/.test(n)) return '›_'
  if (/patch|edit|write|replace|create_file|apply/.test(n)) return '✎'
  if (/read|file|cat|view|open/.test(n)) return '▤'
  if (/search|grep|find|glob|web|fetch|browse|url/.test(n)) return '⌕'
  if (/delegate|agent|spawn|subagent|claude/.test(n)) return '⇢'
  if (/todo|plan|task/.test(n)) return '☐'
  if (/memory|remember|recall/.test(n)) return '◈'
  if (/image|vision|screenshot|camera/.test(n)) return '◩'
  if (/mcp/.test(n)) return '⧉'
  return '⚙'
}

function looksFailed(t: ToolItem): boolean {
  const s = `${t.summary}\n${t.result}`.trim().slice(0, 400)
  return /^(error|erro|failed|falh|traceback|exception)/i.test(s) || /"success"\s*:\s*false|"error"\s*:\s*"[^"]/.test(s)
}

function useElapsed(startedMs: number | undefined, on: boolean): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on || !startedMs) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [on, startedMs])
  return on && startedMs ? Math.max(0, (now - startedMs) / 1000) : null
}

function fmtDur(s: number): string {
  if (s < 1) return `${Math.round(s * 1000)}ms`
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`
}

function ToolCard({ tool, verbose }: { tool: ToolItem; verbose: boolean }) {
  const [open, setOpen] = useState(false)
  const running = tool.status === 'running'
  const failed = !running && looksFailed(tool)
  const elapsed = useElapsed(tool.startedMs, running)
  const hasArgs = Boolean(tool.args && Object.keys(tool.args).length)
  const hasDetail = hasArgs || Boolean(tool.summary || tool.result)
  const dur = tool.duration ?? elapsed
  const tone = running ? 'border-amber/40' : failed ? 'border-alert/40' : 'border-edge'

  return (
    <div className={`overflow-hidden rounded-md border bg-panel/60 font-mono text-[11.5px] ${tone}`}>
      <button
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={`flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left ${hasDetail ? 'cursor-pointer hover:bg-panel2' : 'cursor-default'}`}
      >
        <span className={`w-4 shrink-0 text-center ${running ? 'text-amber' : failed ? 'text-alert' : 'text-dim'}`}>{toolIcon(tool.name)}</span>
        <span className={`shrink-0 ${running ? 'text-amber' : 'text-ink/90'}`}>{tool.name}</span>
        {tool.context && <span className="min-w-0 truncate text-faint">{tool.context}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {dur !== null && <span className="text-[10.5px] text-faint">{fmtDur(dur)}</span>}
          {running ? (
            <span className="hc-pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-amber" title="executando" />
          ) : failed ? (
            <span className="text-alert" title="falhou">✕</span>
          ) : (
            <span className="text-phos" title="concluída">✓</span>
          )}
          {hasDetail && <span className="text-faint">{open ? '▾' : '▸'}</span>}
        </span>
      </button>
      {/claude_(spawn|spawn_many|send)/.test(tool.name) && <DelegationStrip tool={tool} />}
      {!open && verbose && tool.summary && <div className="truncate border-t border-edge/60 px-2.5 py-0.5 pl-8 text-faint">{tool.summary}</div>}
      {open && (
        <div className="hc-fade-in space-y-1.5 border-t border-edge/60 px-2.5 py-2">
          {hasArgs && (
            <div>
              <div className="label mb-0.5 text-[9px]">entrada</div>
              <CodeBlock lang="json" code={safeJson(tool.args)} />
            </div>
          )}
          {tool.summary && <div className="text-dim">{tool.summary}</div>}
          {tool.result && (
            <div>
              <div className="label mb-0.5 text-[9px]">saída</div>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-void px-2 py-1 text-faint">
                {tool.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TurnIndicator({ status }: { status: string }) {
  return (
    <div className="hc-fade-in ml-8 flex items-center gap-2 text-[11.5px] text-amber">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border border-amber/30 border-t-amber" />
      <span className="label text-amber">turno ativo</span>
      {status && <span className="truncate text-dim">· {status}</span>}
    </div>
  )
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

const RUN_ID_RE = /r-\d{8}-\d{6}-[0-9a-f]{4}/g

/** Delegação ao Claude Code vista do chat: instâncias criadas pelo bot, ao vivo. */
function DelegationStrip({ tool }: { tool: ToolItem }) {
  const ids = useMemo(() => [...new Set(`${tool.result ?? ''} ${tool.summary ?? ''}`.match(RUN_ID_RE) ?? [])], [tool.result, tool.summary])
  const s = useSwarm()
  const runs = ids.map((id) => s.runs.find((r) => r.id === id)).filter((r): r is RunMeta => Boolean(r))
  const anyActive = runs.some((r) => isActive(r.status))
  const now = useNow(1000, anyActive)
  if (!ids.length) return null
  return (
    <div className="hc-fade-in border-t border-edge/60 bg-void/40 px-2.5 py-1.5">
      <div className="mb-1 flex items-center gap-2 text-[10px]">
        <span className={`h-1.5 w-1.5 rotate-45 ${anyActive ? 'hc-pulse-dot bg-phos' : 'bg-faint'}`} />
        <span className="label text-[9.5px]">delegado ao Claude Code · {ids.length} instância(s)</span>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('hc:view', { detail: 'swarm' }))}
          className="ml-auto rounded border border-edge2 px-1.5 text-[10px] text-dim hover:border-phos/60 hover:text-phos"
        >
          ver árvore ↗
        </button>
      </div>
      {ids.map((id) => {
        const r = runs.find((x) => x.id === id)
        return (
          <div key={id} className="flex min-w-0 items-center gap-2 py-0.5 text-[10.5px]">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r ? (isActive(r.status) ? 'hc-pulse-dot bg-phos' : r.status === 'done' ? 'bg-phos/60' : 'bg-alert') : 'bg-faint'}`} />
            <span className="min-w-0 flex-1 truncate text-ink/90">{r?.title ?? id}</span>
            {r && <span className="shrink-0 text-faint">{STATUS_LABEL[r.status]}</span>}
            {r && <span className="shrink-0 tabular-nums text-faint">{fmtDuration(runElapsedMs(r, now))}</span>}
            {r && isActive(r.status) && <span className="h-1 w-10 shrink-0 overflow-hidden rounded bg-edge"><span className="hc-shimmer block h-full w-full" /></span>}
          </div>
        )
      })}
    </div>
  )
}
