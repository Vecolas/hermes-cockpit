import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatItem } from '../../lib/chat-store'

interface Props {
  items: ChatItem[]
  verbose: boolean
  running: boolean
  status: string
  /** cards extras no fim do transcript (aprovações) */
  footer?: ReactNode
  empty?: ReactNode
}

export function Transcript({ items, verbose, running, status, footer, empty }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // auto-scroll enquanto o usuário estiver no fim
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      }}
      className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
    >
      {items.length === 0 && !running && !footer && empty}
      <div className="flex flex-col gap-3">
        {groupItems(items).map((g) =>
          g.kind === 'tools' ? (
            <ToolGroup key={g.id} tools={g.tools} verbose={verbose} />
          ) : (
            <Row key={g.item.id} item={g.item} verbose={verbose} />
          ),
        )}
        {running && <TurnIndicator status={status} />}
        {footer}
      </div>
    </div>
  )
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type Group = { kind: 'tools'; id: string; tools: ToolItem[] } | { kind: 'one'; item: ChatItem }

// tool calls consecutivas viram um bloco único (como no wireframe)
function groupItems(items: ChatItem[]): Group[] {
  const out: Group[] = []
  for (const it of items) {
    const last = out.at(-1)
    if (it.kind === 'tool') {
      if (last?.kind === 'tools') last.tools.push(it)
      else out.push({ kind: 'tools', id: `g-${it.id}`, tools: [it] })
    } else out.push({ kind: 'one', item: it })
  }
  return out
}

function Row({ item, verbose }: { item: ChatItem; verbose: boolean }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[78%] whitespace-pre-wrap break-words rounded-lg border border-edge2 bg-panel2 px-3.5 py-2 text-ink">
            {item.text}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className="max-w-[92%]">
          {verbose && item.reasoning && (
            <details className="mb-1.5 text-[11.5px] text-faint" open={item.streaming && !item.text}>
              <summary className="cursor-pointer select-none label">raciocínio</summary>
              <div className="mt-1 whitespace-pre-wrap border-l border-edge2 pl-3 text-faint">{item.reasoning}</div>
            </details>
          )}
          {(item.text || item.streaming) && (
            <div className="whitespace-pre-wrap break-words leading-relaxed text-ink/95">
              {item.text}
              {item.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-amber align-middle" />}
            </div>
          )}
        </div>
      )
    case 'note': {
      const cls =
        item.tone === 'error'
          ? 'border-alert/40 text-alert'
          : item.tone === 'warn'
            ? 'border-amber/40 text-amber'
            : 'border-edge text-dim'
      return <div className={`rounded border px-3 py-1.5 text-[12px] ${cls}`}>{item.text}</div>
    }
    case 'slash':
      return (
        <div className="rounded border border-edge bg-panel px-3 py-2">
          <div className="label mb-1 text-cyanic">{item.command}</div>
          {item.warning && <div className="mb-1 text-[11.5px] text-amber">{item.warning}</div>}
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-[12px] text-dim">{item.output || '(sem saída)'}</pre>
        </div>
      )
    default:
      return null
  }
}

function ToolGroup({ tools, verbose }: { tools: ToolItem[]; verbose: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 border-l border-edge2 pl-3 font-mono text-[12px]">
      {tools.map((t) => (
        <ToolLine key={t.id} tool={t} verbose={verbose} />
      ))}
    </div>
  )
}

function ToolLine({ tool, verbose }: { tool: ToolItem; verbose: boolean }) {
  const [open, setOpen] = useState(false)
  const running = tool.status === 'running'
  const head = (
    <>
      <span className={running ? 'animate-pulse text-amber' : 'text-faint'}>→</span>{' '}
      <span className={running ? 'text-amber' : 'text-dim'}>{tool.name}</span>
      {tool.context && <span className="text-faint"> {tool.context}</span>}
      {tool.duration !== null && <span className="text-faint/70"> · {tool.duration.toFixed(1)}s</span>}
    </>
  )
  if (!verbose) return <div className="truncate">{head}</div>
  const hasDetail = Boolean(tool.args && Object.keys(tool.args).length) || Boolean(tool.summary || tool.result)
  return (
    <div>
      <button
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={`w-full truncate text-left ${hasDetail ? 'cursor-pointer hover:text-ink' : 'cursor-default'}`}
      >
        {hasDetail && <span className="text-faint">{open ? '▾ ' : '▸ '}</span>}
        {head}
      </button>
      {open && (
        <div className="mb-1 ml-4 mt-1 space-y-1 text-[11.5px]">
          {tool.args && Object.keys(tool.args).length > 0 && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-void px-2 py-1 text-faint">
              {safeJson(tool.args)}
            </pre>
          )}
          {tool.summary && <div className="text-dim">{tool.summary}</div>}
          {tool.result && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-void px-2 py-1 text-faint">
              {tool.result}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function TurnIndicator({ status }: { status: string }) {
  return (
    <div className="flex items-center gap-2 text-[11.5px] text-amber">
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
