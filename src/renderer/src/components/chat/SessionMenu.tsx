import { useEffect, useRef, useState } from 'react'
import type { SessionRow } from '../../lib/gateway'

export type SessionTarget =
  | { kind: 'canonical' }
  | { kind: 'side'; storedId: string; title: string; /** profile dono (preenchido pelo ChatPane) */ profile?: string }

interface Props {
  active: SessionTarget
  sideChats: SessionRow[]
  sideError: string | null
  disabled: boolean
  onPick: (t: SessionTarget) => void
  onNew: () => void
  onRefresh: () => void
}

function label(s: SessionRow): string {
  return s.title?.trim() || s.preview?.trim().slice(0, 48) || s.id
}

// Dropdown de sessões: Bot Chat canônico + side-chats do profile + "novo side-chat".
export function SessionMenu({ active, sideChats, sideError, disabled, onPick, onNew, onRefresh }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const current = active.kind === 'canonical' ? 'Bot Chat' : active.title || 'side-chat'

  return (
    <div ref={ref} className="relative">
      <button
        disabled={disabled}
        onClick={() => {
          if (!open) onRefresh()
          setOpen((v) => !v)
        }}
        className="flex max-w-[200px] items-center gap-1.5 rounded border border-edge2 px-2 py-1 text-[11.5px] text-ink hover:border-amber/50 disabled:opacity-50"
      >
        <span className="truncate">{current}</span>
        <span className="text-faint">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-edge2 bg-panel py-1 shadow-2xl">
          <button
            onClick={() => {
              setOpen(false)
              onPick({ kind: 'canonical' })
            }}
            className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] hover:bg-panel2 ${
              active.kind === 'canonical' ? 'text-amber' : 'text-ink'
            }`}
          >
            <span>Bot Chat</span>
            <span className="label">canônico</span>
          </button>
          <div className="label border-t border-edge px-3 pb-1 pt-2">Side-chats</div>
          {sideError && <div className="px-3 py-1 text-[11px] text-alert">{sideError}</div>}
          {!sideError && sideChats.length === 0 && <div className="px-3 py-1 text-[11px] text-faint">nenhum side-chat</div>}
          <div className="max-h-64 overflow-y-auto">
            {sideChats.map((s) => {
              const isActive = active.kind === 'side' && active.storedId === s.id
              return (
                <button
                  key={s.id}
                  onClick={() => {
                    setOpen(false)
                    onPick({ kind: 'side', storedId: s.id, title: label(s) })
                  }}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-1 text-left text-[12px] hover:bg-panel2 ${
                    isActive ? 'text-amber' : 'text-dim'
                  }`}
                >
                  <span className="truncate">{label(s)}</span>
                  {typeof s.message_count === 'number' && <span className="text-[10px] text-faint">{s.message_count}</span>}
                </button>
              )
            })}
          </div>
          <button
            onClick={() => {
              setOpen(false)
              onNew()
            }}
            className="mt-1 w-full border-t border-edge px-3 py-1.5 text-left text-[12px] text-phos hover:bg-panel2"
          >
            + novo side-chat
          </button>
        </div>
      )}
    </div>
  )
}
