import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cx } from './cx'

export interface TabItem<T extends string = string> {
  id: T
  label: ReactNode
  icon?: ReactNode
  /** contador/selo à direita (ex.: <Badge count={3}/>) */
  badge?: ReactNode
  title?: string
  disabled?: boolean
}

/**
 * Abas acessíveis (role=tablist, ←/→/Home/End) com indicador deslizante.
 * `variant="pill"` (topbar/segmentado) ou `"line"` (sublinhado, para painéis).
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  variant = 'line',
  className,
  ariaLabel,
  labelClassName,
  controls,
}: {
  items: TabItem<T>[]
  value: T
  onChange: (id: T) => void
  variant?: 'pill' | 'line'
  className?: string
  ariaLabel?: string
  /** classe extra no texto (ex.: esconder em janela estreita) */
  labelClassName?: string
  /** id do tabpanel controlado por cada aba (emite aria-controls) */
  controls?: (id: T) => string
}) {
  const box = useRef<HTMLDivElement>(null)
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null)

  useLayoutEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(value)}"]`)
    if (!el || !box.current) return
    const measure = () => setInd({ x: el.offsetLeft, w: el.offsetWidth })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(box.current)
    ro.observe(el)
    return () => ro.disconnect()
  }, [value, items.length])

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = items.filter((t) => !t.disabled)
    const i = enabled.findIndex((t) => t.id === value)
    let next: TabItem<T> | undefined
    if (e.key === 'ArrowRight') next = enabled[(i + 1) % enabled.length]
    else if (e.key === 'ArrowLeft') next = enabled[(i - 1 + enabled.length) % enabled.length]
    else if (e.key === 'Home') next = enabled[0]
    else if (e.key === 'End') next = enabled[enabled.length - 1]
    if (!next) return
    e.preventDefault()
    onChange(next.id)
    box.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(next.id)}"]`)?.focus()
  }

  const pill = variant === 'pill'
  return (
    <div
      ref={box}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKey}
      className={cx(
        'no-drag relative flex items-center',
        pill ? 'hc-viewtabs gap-0.5 rounded-lg border border-edge bg-void/50 p-[3px]' : 'gap-1 border-b border-edge',
        className,
      )}
    >
      {ind && pill && (
        <span aria-hidden className="hc-viewtabs-ind" style={{ width: ind.w, transform: `translateX(${ind.x}px)` }} />
      )}
      {ind && !pill && (
        <span
          aria-hidden
          className="pointer-events-none absolute -bottom-px left-0 h-[1.5px] rounded bg-amber transition-[transform,width] duration-[var(--hc-dur-3)] ease-[var(--hc-ease-out)]"
          style={{ width: ind.w, transform: `translateX(${ind.x}px)` }}
        />
      )}
      {items.map((t) => {
        const on = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-tab-id={t.id}
            aria-selected={on}
            aria-controls={controls?.(t.id)}
            tabIndex={on ? 0 : -1}
            disabled={t.disabled}
            title={t.title}
            onClick={() => onChange(t.id)}
            className={cx(
              'hc-press relative z-[1] flex items-center gap-1.5 whitespace-nowrap disabled:opacity-40',
              pill ? 'h-6 rounded-md px-2.5 text-[11px]' : 'px-3 py-1.5 text-[11px]',
              on ? 'text-ink' : 'text-faint hover:text-dim',
            )}
          >
            {t.icon && <span className={cx('text-[12px] leading-none', on && 'text-amber')} aria-hidden>{t.icon}</span>}
            <span className={labelClassName}>{t.label}</span>
            {t.badge}
          </button>
        )
      })}
    </div>
  )
}
