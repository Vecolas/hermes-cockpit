import { invoke } from './ipc'
import { toast } from './toast'

// Janelas de chat avulsas: cada uma é o mesmo renderer com ?window=chat&bot=<profile>,
// renderizando só o ChatPane (com abas próprias) e o próprio HermesRpc.

export interface WindowParams {
  kind: 'main' | 'chat'
  bot: string | null
  /** side-chat a abrir ao iniciar (aba destacada para nova janela) */
  session: { id: string; title: string } | null
}

export function windowParams(): WindowParams {
  const q = new URLSearchParams(location.search)
  const sid = q.get('session')
  return {
    kind: q.get('window') === 'chat' ? 'chat' : 'main',
    bot: q.get('bot'),
    session: sid ? { id: sid, title: q.get('title') || 'side-chat' } : null,
  }
}

export function openChatWindow(bot?: string | null, session?: { id: string; title: string }): void {
  invoke('ops:window.open', { kind: 'chat', bot: bot ?? undefined, session: session?.id, title: session?.title }).catch((e: unknown) =>
    toast({ title: 'Não abriu a janela', detail: e instanceof Error ? e.message : String(e), tone: 'error' }),
  )
}
