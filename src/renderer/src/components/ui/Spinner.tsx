import { cx } from './cx'

/** Spinner circular leve (borda + hc-spin). Herda a cor do texto. */
export function Spinner({ size = 12, className, label = 'carregando' }: { size?: number; className?: string; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cx('hc-spin inline-block shrink-0 rounded-full border-[1.5px] border-current border-r-transparent opacity-80', className)}
      style={{ width: size, height: size }}
    />
  )
}
