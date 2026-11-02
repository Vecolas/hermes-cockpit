import { useEffect, useMemo, useRef, useState } from 'react'
import { botTitle, parseProfiles, type BotProfile } from '../lib/bots'
import { connectBackend } from '../lib/connection'
import { HermesRpc, type ConnState } from '../lib/rpc'
import { applyTheme, loadTheme } from '../lib/theme'
import { openChatWindow } from '../lib/windows'
import { setAutoMode, useAutoMode } from '../lib/automode'
import { ChatPane } from './ChatPane'
import { ErrorBoundary } from './ErrorBoundary'
import { Toaster } from './ui/Toaster'

// Janela de chat avulsa (?window=chat&bot=<profile>): só o ChatPane — com as
// abas de sessão dele — e um HermesRpc próprio sobre o mesmo backend do main.
// Trocar o bot aqui não afeta a janela principal.

export function ChatWindow({ initialBot, session }: { initialBot: string | null; session?: { id: string; title: string } | null }) {
  const [rpc, setRpc] = useState<HermesRpc | null>(null)
  const [connState, setConnState] = useState<ConnState>('idle')
  const [fatal, setFatal] = useState<string | null>(null)
  const [bots, setBots] = useState<BotProfile[]>([])
  const [selected, setSelected] = useState<string>(initialBot || 'chief')
  const auto = useAutoMode()

  useEffect(() => applyTheme(loadTheme()), [])

  useEffect(() => {
    let alive = true
    let client: HermesRpc | null = null
    connectBackend()
      .then((c) => {
        if (!alive) return
        client = new HermesRpc()
        client.onState = (s) => alive && setConnState(s)
        client.connect(c.info.wsUrl)
        setRpc(client)
      })
      .catch((e: Error) => alive && setFatal(e.message))
    return () => {
      alive = false
      client?.close()
    }
  }, [])

  useEffect(() => {
    if (!rpc || connState !== 'open') return
    rpc
      .call('profiles.list')
      .then((r) => setBots(parseProfiles(r)))
      .catch(() => {})
  }, [rpc, connState])

  const bot = useMemo(
    () => bots.find((b) => b.name === selected) ?? (bots.length ? null : { name: selected, group: 'outros' }),
    [bots, selected],
  )

  // aba destacada de outra janela: abre o side-chat quando o ChatPane estiver pronto
  const openedSession = useRef(false)
  useEffect(() => {
    if (!session || openedSession.current || connState !== 'open' || !bots.length) return
    openedSession.current = true
    const t = setTimeout(
      () => window.dispatchEvent(new CustomEvent('hc:chat-open-session', { detail: { profile: selected, id: session.id, title: session.title } })),
      600,
    )
    return () => clearTimeout(t)
  }, [session, connState, bots.length, selected])

  useEffect(() => {
    document.title = `${botTitle(selected)} · Hermes Cockpit`
  }, [selected])

  return (
    <div className="flex h-full flex-col bg-void">
      <header className={`app-drag flex h-11 shrink-0 items-center gap-2 border-b border-edge bg-panel pr-2 ${window.hermes?.platform === 'darwin' ? 'pl-[84px]' : 'pl-3'}`}>
        <span className="h-2 w-2 rotate-45 bg-amber" aria-hidden />
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          title="bot desta janela"
          className="no-drag rounded border border-edge2 bg-void px-2 py-0.5 text-[12px] text-ink outline-none focus:border-amber/60"
        >
          {(bots.length ? bots : [{ name: selected, group: 'outros' } as BotProfile]).map((b) => (
            <option key={b.name} value={b.name}>
              {botTitle(b.name)}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void setAutoMode(!auto)}
          title="auto mode (Hermes smart + swarm auto)"
          className={`no-drag rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${
            auto ? 'border-phos/60 bg-phos/10 text-phos' : 'border-edge2 text-faint hover:text-dim'
          }`}
        >
          auto
        </button>
        <button
          type="button"
          onClick={() => openChatWindow(selected)}
          title="outra janela de chat (⌘⇧N)"
          className="no-drag rounded border border-edge2 px-2 py-0.5 text-[11px] text-dim hover:border-amber/50 hover:text-ink"
        >
          ⧉
        </button>
      </header>
      <div className="min-h-0 flex-1">
        {fatal ? (
          <div className="p-6 text-[12px] text-alert">backend: {fatal}</div>
        ) : (
          <ErrorBoundary label="Chat">
            <ChatPane key={selected} rpc={rpc} bot={bot} connState={connState} />
          </ErrorBoundary>
        )}
      </div>
      <Toaster />
    </div>
  )
}
