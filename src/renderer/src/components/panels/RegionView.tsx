import { useEffect, useRef, useState } from 'react'
import { Group, Panel, useDefaultLayout } from 'react-resizable-panels'
import { safeStorage } from '../../lib/layout'
import { PANELS, PANEL_BY_ID, type Region } from '../../lib/panels'
import { ErrorBoundary } from '../ErrorBoundary'
import { ResizeHandle } from '../layout/ResizeHandle'

// Região editável de blocos do registry (strip, cards do dock, rodapé da rail).
// - cada bloco vira um Panel redimensionável, com alça entre vizinhos;
// - hover no bloco mostra a barrinha ◂ ▸ × (mover / esconder);
// - "+" no canto da região adiciona um bloco escondido de volta.
// Tamanhos ficam salvos por combinação de blocos: esconder e reexibir um bloco
// volta ao layout que aquela combinação tinha.

export const REGION_GROUP_PREFIX = 'hc-region-'

interface Props {
  region: Region
  ids: string[]
  orientation: 'horizontal' | 'vertical'
  /** tamanho mínimo de cada bloco (px) */
  minPx: number
  onChange: (ids: string[]) => void
  className?: string
  emptyText?: string
}

export function RegionView({ region, ids, orientation, minPx, onChange, className = '', emptyText }: Props) {
  const defs = ids.map((id) => PANEL_BY_ID[id]).filter(Boolean)
  const groupId = `${REGION_GROUP_PREFIX}${region}:${defs.map((d) => d.id).join('+')}`
  const layout = useDefaultLayout({ id: groupId, storage: safeStorage, onlySaveAfterUserInteractions: true })
  const horizontal = orientation === 'horizontal'

  const hide = (id: string) => onChange(ids.filter((x) => x !== id))
  const move = (id: string, d: -1 | 1) => {
    const list = [...ids]
    const i = list.indexOf(id)
    const j = i + d
    if (i < 0 || j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    onChange(list)
  }
  const hidden = PANELS.filter((p) => !ids.includes(p.id))

  return (
    <div className={`group/region relative h-full min-h-0 w-full min-w-0 ${className}`}>
      {defs.length === 0 ? (
        <div className="px-4 py-3 text-[11px] text-faint">{emptyText ?? 'região vazia — use + para adicionar um bloco.'}</div>
      ) : (
        // key: a combinação de blocos mudou → remonta e restaura o layout salvo dela
        <Group
          key={groupId}
          id={groupId}
          orientation={orientation}
          className="h-full w-full"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
        >
          {defs.map((def, i) => {
            const C = def.componente
            return [
              i > 0 && <ResizeHandle key={`sep-${def.id}`} orientation={orientation} title="arraste para redimensionar" />,
              <Panel key={def.id} id={def.id} minSize={minPx}>
                <div className="group/block relative h-full min-h-0 min-w-0">
                  <ErrorBoundary label={def.titulo}>
                    <C refreshMs={def.refreshMs} />
                  </ErrorBoundary>
                  <BlockToolbar
                    titulo={def.titulo}
                    horizontal={horizontal}
                    canBack={i > 0}
                    canFwd={i < defs.length - 1}
                    onMove={(d) => move(def.id, d)}
                    onHide={() => hide(def.id)}
                  />
                </div>
              </Panel>,
            ]
          })}
        </Group>
      )}
      <AddMenu hidden={hidden} onAdd={(id) => onChange([...ids, id])} alwaysVisible={defs.length === 0} />
    </div>
  )
}

function BlockToolbar({
  titulo,
  horizontal,
  canBack,
  canFwd,
  onMove,
  onHide,
}: {
  titulo: string
  horizontal: boolean
  canBack: boolean
  canFwd: boolean
  onMove: (d: -1 | 1) => void
  onHide: () => void
}) {
  const btn =
    'flex h-5 w-5 items-center justify-center rounded text-[11px] text-faint hover:bg-panel2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent'
  return (
    <div className="pointer-events-none absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded border border-edge bg-panel/95 px-0.5 opacity-0 shadow transition-opacity group-hover/block:pointer-events-auto group-hover/block:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
      <button type="button" className={btn} disabled={!canBack} onClick={() => onMove(-1)} title="mover para trás">
        {horizontal ? '◂' : '▴'}
      </button>
      <button type="button" className={btn} disabled={!canFwd} onClick={() => onMove(1)} title="mover para frente">
        {horizontal ? '▸' : '▾'}
      </button>
      <button type="button" className={`${btn} hover:!text-alert`} onClick={onHide} title={`esconder "${titulo}" (volta pelo +)`}>
        ×
      </button>
    </div>
  )
}

function AddMenu({
  hidden,
  onAdd,
  alwaysVisible,
}: {
  hidden: typeof PANELS
  onAdd: (id: string) => void
  alwaysVisible: boolean
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  if (!hidden.length) return null
  return (
    <div
      ref={box}
      className={`absolute bottom-1.5 right-1.5 z-20 transition-opacity ${
        alwaysVisible || open ? 'opacity-100' : 'opacity-0 group-hover/region:opacity-100'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="adicionar bloco"
        className="flex h-5 w-5 items-center justify-center rounded border border-edge2 bg-panel text-[12px] text-dim hover:border-amber/60 hover:text-amber"
      >
        +
      </button>
      {open && (
        <div className="absolute bottom-6 right-0 min-w-[200px] rounded-md border border-edge2 bg-panel2 py-1 shadow-lg">
          <div className="label px-3 pb-1 pt-0.5">adicionar bloco</div>
          {hidden.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                onAdd(p.id)
                setOpen(false)
              }}
              className="block w-full px-3 py-1 text-left text-[11px] text-dim hover:bg-panel hover:text-ink"
            >
              {p.titulo}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
