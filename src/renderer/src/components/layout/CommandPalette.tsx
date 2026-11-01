import { useEffect, useMemo, useRef, useState } from 'react'

export interface PaletteItem {
  id: string
  label: string
  hint?: string
  group: string
  run: () => void
}

// Command palette simples (⌘K): filtra por texto, ↑/↓ navega, Enter executa,
// Esc fecha. Itens vêm do App (bots + ações de layout/tema).
export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const filtered = useMemo(() => {
    const terms = q.toLowerCase().trim().split(/\s+/).filter(Boolean)
    if (!terms.length) return items
    return items.filter((it) => {
      const hay = `${it.group} ${it.label} ${it.hint ?? ''}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [items, q])

  useEffect(() => setIdx(0), [q])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  const exec = (it: PaletteItem | undefined) => {
    if (!it) return
    onClose()
    it.run()
  }

  return (
    <div className="no-drag fixed inset-0 z-50 flex items-start justify-center bg-void/60 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Command palette"
        className="w-[min(560px,92vw)] overflow-hidden rounded-lg border border-edge2 bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIdx((i) => Math.min(filtered.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIdx((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              exec(filtered[idx])
            }
          }}
          placeholder="Comando, bot, ação…"
          className="w-full border-b border-edge bg-transparent px-4 py-3 text-[13px] text-ink placeholder:text-faint focus:outline-none"
        />
        <ul ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 && <li className="px-4 py-2 text-[11px] text-faint">nada encontrado</li>}
          {filtered.map((it, i) => (
            <li key={it.id}>
              <button
                type="button"
                data-idx={i}
                onMouseEnter={() => setIdx(i)}
                onClick={() => exec(it)}
                className={`flex w-full items-center gap-3 px-4 py-1.5 text-left text-[12px] ${
                  i === idx ? 'bg-panel2 text-ink' : 'text-dim'
                }`}
              >
                <span className="label w-16 shrink-0">{it.group}</span>
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.hint && <span className="shrink-0 text-[10px] text-faint">{it.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-edge px-4 py-1.5 text-[10px] text-faint">
          ↑↓ navegar · Enter executar · Esc fechar · /skills ficam no composer do chat
        </div>
      </div>
    </div>
  )
}
