import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { SPACES, SPACE_ORDER, setSpace, useSpace, type Space } from '../../lib/space'
import { Icon, type IconName } from '../ui/Icon'
import { cx } from '../ui/cx'

const ICON: Record<Space, IconName> = { pessoal: 'user', houer: 'briefcase', tudo: 'layers' }

/**
 * Seletor de espaço Pessoal | Houer | Tudo (segmented control). O indicador
 * desliza com mola e assume a cor do espaço (--color-space). ⌘⇧1/2/3 no App.
 */
export function SpaceSwitch({ compact }: { compact?: boolean }) {
  const space = useSpace()
  const box = useRef<HTMLDivElement>(null)
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null)

  useLayoutEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-space-id="${space}"]`)
    if (!el || !box.current) return
    const measure = () => setInd({ x: el.offsetLeft, w: el.offsetWidth })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(box.current)
    return () => ro.disconnect()
  }, [space, compact])

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = SPACE_ORDER.indexOf(space)
    const next =
      e.key === 'ArrowRight' ? SPACE_ORDER[(i + 1) % 3] : e.key === 'ArrowLeft' ? SPACE_ORDER[(i + 2) % 3] : null
    if (!next) return
    e.preventDefault()
    setSpace(next)
    box.current?.querySelector<HTMLElement>(`[data-space-id="${next}"]`)?.focus()
  }

  return (
    <div
      ref={box}
      role="radiogroup"
      aria-label="Espaço"
      onKeyDown={onKey}
      className="no-drag hc-space-switch flex shrink-0 items-center gap-0.5 rounded-lg border border-edge bg-void/50 p-[2px]"
    >
      {ind && <span aria-hidden className="hc-space-ind" style={{ width: ind.w, transform: `translateX(${ind.x}px)` }} />}
      {SPACE_ORDER.map((id, i) => {
        const def = SPACES.find((s) => s.id === id)!
        const on = id === space
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-space-id={id}
            onClick={() => setSpace(id)}
            title={`${def.label} — ${def.hint} (⌘⇧${i + 1})`}
            className={cx(
              'hc-press relative z-[1] flex h-6 items-center gap-1.5 rounded-md px-2 text-[10.5px] font-medium tracking-[0.08em] uppercase',
              on ? 'text-ink' : 'text-faint hover:text-dim',
            )}
          >
            <Icon name={ICON[id]} size={12} className={cx('transition-colors duration-[var(--hc-dur-3)]', on && 'text-space')} />
            {!compact && <span className="hc-space-label">{def.label}</span>}
          </button>
        )
      })}
    </div>
  )
}
