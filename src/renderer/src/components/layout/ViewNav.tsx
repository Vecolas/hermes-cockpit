import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { ViewId } from '../../lib/layout'
import { Icon } from '../ui/Icon'
import { cx } from '../ui/cx'
import { VIEW_BY_ID } from './views'

/**
 * Barra de views da topbar: ícone + rótulo, indicador deslizante na cor do
 * espaço, ←/→/Home/End, e arrastar para reordenar (a ordem define ⌘1..⌘6).
 */
export function ViewNav({
  views,
  value,
  onChange,
  onReorder,
  badges,
}: {
  /** views visíveis, na ordem */
  views: ViewId[]
  value: ViewId
  onChange: (v: ViewId) => void
  /** nova ordem das views visíveis */
  onReorder: (order: ViewId[]) => void
  badges?: Partial<Record<ViewId, ReactNode>>
}) {
  const box = useRef<HTMLDivElement>(null)
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null)
  const [drag, setDrag] = useState<ViewId | null>(null)
  const [drop, setDrop] = useState<{ id: ViewId; side: 'before' | 'after' } | null>(null)

  useLayoutEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-tab-id="${value}"]`)
    if (!el || !box.current) {
      setInd(null)
      return
    }
    const measure = () => setInd({ x: el.offsetLeft, w: el.offsetWidth })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(box.current)
    ro.observe(el)
    return () => ro.disconnect()
  }, [value, views.join(',')])

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = views.indexOf(value)
    let next: ViewId | undefined
    if (e.key === 'ArrowRight') next = views[(i + 1) % views.length]
    else if (e.key === 'ArrowLeft') next = views[(i - 1 + views.length) % views.length]
    else if (e.key === 'Home') next = views[0]
    else if (e.key === 'End') next = views[views.length - 1]
    if (!next) return
    e.preventDefault()
    onChange(next)
    box.current?.querySelector<HTMLElement>(`[data-tab-id="${next}"]`)?.focus()
  }

  const onDragOver = (id: ViewId) => (e: DragEvent<HTMLButtonElement>) => {
    if (!drag || drag === id) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const r = e.currentTarget.getBoundingClientRect()
    const side = e.clientX < r.left + r.width / 2 ? 'before' : 'after'
    if (drop?.id !== id || drop.side !== side) setDrop({ id, side })
  }
  const onDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault()
    if (!drag || !drop) return end()
    const list = views.filter((v) => v !== drag)
    const j = list.indexOf(drop.id)
    list.splice(drop.side === 'before' ? j : j + 1, 0, drag)
    end()
    if (list.join() !== views.join()) onReorder(list)
  }
  const end = () => {
    setDrag(null)
    setDrop(null)
  }

  return (
    <div
      ref={box}
      role="tablist"
      aria-label="Views"
      onKeyDown={onKey}
      className="no-drag hc-viewtabs relative flex shrink-0 items-center gap-0.5 rounded-lg border border-edge bg-void/50 p-[3px]"
    >
      {ind && <span aria-hidden className="hc-viewtabs-ind" style={{ width: ind.w, transform: `translateX(${ind.x}px)` }} />}
      {views.map((id, i) => {
        const v = VIEW_BY_ID[id]
        const on = id === value
        return (
          <button
            key={id}
            type="button"
            role="tab"
            data-tab-id={id}
            aria-selected={on}
            aria-controls={`view-${id}`}
            tabIndex={on ? 0 : -1}
            draggable
            onDragStart={(e) => {
              setDrag(id)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', id)
            }}
            onDragOver={onDragOver(id)}
            onDragLeave={() => drop?.id === id && setDrop(null)}
            onDrop={onDrop}
            onDragEnd={end}
            data-dragging={drag === id || undefined}
            data-drop={drop?.id === id ? drop.side : undefined}
            onClick={() => onChange(id)}
            title={`${v.label} — ${v.hint}${i < 9 ? ` (⌘${i + 1})` : ''} · arraste para reordenar`}
            className={cx(
              'hc-viewtab hc-press relative z-[1] flex h-6 items-center gap-1.5 rounded-md px-2.5 text-[11px] whitespace-nowrap',
              on ? 'text-ink' : 'text-faint hover:text-dim',
            )}
          >
            <Icon name={v.icon} size={13} className={cx('transition-colors duration-[var(--hc-dur-2)]', on && 'text-space')} />
            <span className="hc-tab-label">{v.label}</span>
            {badges?.[id]}
          </button>
        )
      })}
    </div>
  )
}
