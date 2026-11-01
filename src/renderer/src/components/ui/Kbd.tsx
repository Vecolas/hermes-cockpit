import { cx } from './cx'

/** Tecla/atalho. Aceita "⌘K" ou ["⌘", "K"]. */
export function Kbd({ keys, className }: { keys: string | string[]; className?: string }) {
  const list = Array.isArray(keys) ? keys : [keys]
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-0.5', className)}>
      {list.map((k, i) => (
        <kbd
          key={i}
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-edge2 border-b-[2px] bg-panel2 px-1 font-mono text-[10px] leading-none text-dim"
        >
          {k}
        </kbd>
      ))}
    </span>
  )
}
