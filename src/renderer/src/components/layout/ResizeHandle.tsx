import { useEffect, useRef, type RefObject } from 'react'
import { Separator, type PanelImperativeHandle } from 'react-resizable-panels'

/** folga (px) em volta da linha de 1px que ainda conta como duplo clique na alça */
const DBL_SLOP = 6

// Alça de resize no estilo grafite: 1px de borda visível, área de pega maior
// (o próprio react-resizable-panels garante o alvo mínimo), realce âmbar no
// hover/drag. Duplo clique recolhe/expande o painel colapsável vizinho.
//
// O dblclick nativo da lib fica desligado (ele restaura o defaultSize, não
// recolhe). O nosso é tratado no documento por hit-test geométrico: na área de
// pega expandida o alvo do evento é o painel vizinho, não o elemento de 1px.
export function ResizeHandle({
  orientation,
  onToggle,
  title,
  disabled,
}: {
  /** orientação do Group pai */
  orientation: 'horizontal' | 'vertical'
  onToggle?: () => void
  title?: string
  disabled?: boolean
}) {
  const el = useRef<HTMLDivElement | null>(null)
  const toggle = useRef(onToggle)
  toggle.current = onToggle

  useEffect(() => {
    if (disabled) return
    const onDbl = (e: MouseEvent) => {
      const node = el.current
      if (!node || !toggle.current || e.defaultPrevented) return
      const r = node.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return
      const hit =
        orientation === 'horizontal'
          ? e.clientX >= r.left - DBL_SLOP && e.clientX <= r.right + DBL_SLOP && e.clientY >= r.top && e.clientY <= r.bottom
          : e.clientY >= r.top - DBL_SLOP && e.clientY <= r.bottom + DBL_SLOP && e.clientX >= r.left && e.clientX <= r.right
      if (!hit) return
      e.preventDefault()
      toggle.current()
    }
    document.addEventListener('dblclick', onDbl, true)
    return () => document.removeEventListener('dblclick', onDbl, true)
  }, [orientation, disabled])

  return (
    <Separator
      elementRef={el}
      disableDoubleClick
      disabled={disabled}
      title={title}
      className={`hc-sep ${orientation === 'horizontal' ? 'hc-sep-x' : 'hc-sep-y'}`}
    />
  )
}

/**
 * Mantém um painel colapsável em sincronia com o estado desejado (preferência,
 * modo foco, breakpoint). Repete no próximo frame porque o Group só tem
 * layout depois do primeiro paint.
 */
export function useCollapseSync(
  ref: RefObject<PanelImperativeHandle | null>,
  visible: boolean,
  /** último tamanho aberto (px CSS) — restaurado ao expandir, se conhecido */
  lastPx?: RefObject<number | null>,
): void {
  useEffect(() => {
    const sync = () => {
      const p = ref.current
      if (!p) return
      try {
        if (visible && p.isCollapsed()) {
          p.expand()
          const px = lastPx?.current
          if (px && px > 0) p.resize(px)
        } else if (!visible && !p.isCollapsed()) p.collapse()
      } catch {
        /* painel ainda não registrado no Group */
      }
    }
    sync()
    const raf = requestAnimationFrame(sync)
    return () => cancelAnimationFrame(raf)
  }, [ref, visible, lastPx])
}
