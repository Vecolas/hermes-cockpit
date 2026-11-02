import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { ViewId } from '../../lib/layout'
import type { IconName } from '../ui/Icon'

// Views da área central (Chat · Swarm · Ops · Transcrever). O shell mantém
// cada view montada depois da primeira visita (keep-alive: stream do chat,
// gravação do transcriber e rascunhos não se perdem) e só esconde as inativas.
// Views que fazem polling devem pausar quando escondidas:
//
//   const active = useViewActive()
//   useEffect(() => { if (!active) return; const t = setInterval(load, 5000); return () => clearInterval(t) }, [active])

export interface ViewDef {
  id: ViewId
  label: string
  /** ícone SVG (components/ui/Icon) */
  icon: IconName
  /** glifo de texto para listas só-texto (paleta ⌘K) */
  glyph: string
  /** atalho padrão; o real (⌘1..⌘6) segue a ordem das views VISÍVEIS (lib/layout visibleViews) */
  key: string
  hint: string
}

export const VIEWS: ViewDef[] = [
  { id: 'chat', label: 'Chat', icon: 'chat', glyph: '◆', key: '1', hint: 'chat do bot selecionado' },
  { id: 'swarm', label: 'Swarm', icon: 'swarm', glyph: '⋮⋮', key: '2', hint: 'runs de Claude Code e subagents' },
  { id: 'automacoes', label: 'Automações', icon: 'automations', glyph: '⟳', key: '3', hint: 'crons, blueprints, kanban e workflows salvos' },
  { id: 'notion', label: 'Notion', icon: 'notion', glyph: 'N', key: '4', hint: 'tarefas, busca e páginas do Notion' },
  { id: 'ops', label: 'Ops', icon: 'ops', glyph: '⌁', key: '5', hint: 'modelos, portas, processos, repos, containers' },
  { id: 'transcrever', label: 'Transcrever', icon: 'transcribe', glyph: '◉', key: '6', hint: 'transcriber local: arquivo, YouTube, tempo real' },
]

export const VIEW_BY_ID = Object.fromEntries(VIEWS.map((v) => [v.id, v])) as Record<ViewId, ViewDef>

const ActiveCtx = createContext(true)

/** true quando a view que contém o componente está visível. Fora de uma view: sempre true. */
export function useViewActive(): boolean {
  return useContext(ActiveCtx)
}

/**
 * Hospeda uma view. `keepMounted`: monta já de início (o chat). As demais
 * montam na 1ª visita e ficam vivas escondidas. Ao ativar, entra com hc-view-in
 * (a animação reinicia porque o display volta de none).
 */
export function ViewSlot({
  id,
  active,
  keepMounted,
  children,
}: {
  id: ViewId
  active: boolean
  keepMounted?: boolean
  children: ReactNode
}) {
  const [visited, setVisited] = useState(active || Boolean(keepMounted))
  useEffect(() => {
    if (active) setVisited(true)
  }, [active])
  // active já conta como visitado neste mesmo commit: os efeitos da view
  // (listeners de hc:*) rodam antes dos efeitos do App que despacham intents.
  if (!visited && !active) return null
  return (
    <div
      role="tabpanel"
      id={`view-${id}`}
      aria-hidden={!active}
      inert={!active}
      data-view={id}
      className={`absolute inset-0 min-h-0 min-w-0 ${active ? 'hc-view-in' : 'hidden'}`}
    >
      <ActiveCtx.Provider value={active}>{children}</ActiveCtx.Provider>
    </div>
  )
}
