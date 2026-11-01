import { useEffect, useRef, useState } from 'react'
import { BotsRail } from './components/BotsRail'
import { ChatPane } from './components/ChatPane'
import { DockPane } from './components/DockPane'
import { StatusStrip } from './components/StatusStrip'
import { parseProfiles, type BotProfile } from './lib/bots'
import { connectBackend, saveManual, type Connection } from './lib/connection'
import { HermesRpc, type ConnState } from './lib/rpc'

export function App() {
  const [conn, setConn] = useState<Connection | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [needsManual, setNeedsManual] = useState(false)
  const [connState, setConnState] = useState<ConnState>('idle')
  const [bots, setBots] = useState<BotProfile[]>([])
  const [selected, setSelected] = useState<string | null>('chief')
  const rpcRef = useRef<HermesRpc | null>(null)

  useEffect(() => {
    let alive = true
    connectBackend()
      .then(async (c) => {
        if (!alive) return
        setConn(c)
        const rpc = new HermesRpc()
        rpcRef.current = rpc
        rpc.onState = (s) => alive && setConnState(s)
        rpc.connect(c.info.wsUrl)
        // Prova de vida: rail de bots alimentada pelo próprio backend
        await new Promise((r) => setTimeout(r, 400))
        try {
          const res = await rpc.call('profiles.list')
          if (alive) setBots(parseProfiles(res))
        } catch (e) {
          console.warn('profiles.list falhou:', e)
        }
      })
      .catch((e: Error) => {
        if (!alive) return
        if (e.message === 'no-manual-connection') setNeedsManual(true)
        else setFatal(e.message)
      })
    return () => {
      alive = false
      rpcRef.current?.close()
    }
  }, [])

  if (needsManual) return <ManualConnect onDone={() => location.reload()} />

  if (fatal) {
    return (
      <div className="flex h-full items-center justify-center bg-void p-8">
        <div className="max-w-lg rounded-lg border border-alert/40 bg-panel p-6">
          <div className="label mb-2 text-alert">Falha ao subir o backend</div>
          <pre className="whitespace-pre-wrap text-[12px] text-dim">{fatal}</pre>
          <p className="mt-3 text-[11px] text-faint">
            Verifique se o CLI está no PATH (<code>which hermes</code>) e tente{' '}
            <code>hermes serve</code> manualmente.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="grid h-full grid-rows-[1fr_auto]">
      <div className="grid min-h-0 grid-cols-[240px_1fr_360px]">
        <BotsRail bots={bots} selected={selected} onSelect={setSelected} loading={!conn} />
        <ChatPane bot={selected} connState={connState} wsUrl={conn?.info.wsUrl ?? null} />
        <DockPane />
      </div>
      <StatusStrip conn={conn} />
    </div>
  )
}

// Modo navegador (dev:web): sem bridge do Electron, conecta com URL + token.
function ManualConnect({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState('http://127.0.0.1:8642')
  const [token, setToken] = useState('')
  return (
    <div className="flex h-full items-center justify-center bg-void p-8">
      <form
        className="w-full max-w-md rounded-lg border border-edge bg-panel p-6"
        onSubmit={(e) => {
          e.preventDefault()
          saveManual(url, token)
          onDone()
        }}
      >
        <div className="label mb-1">Modo navegador</div>
        <h1 className="font-display mb-4 text-xl">Conectar ao hermes serve</h1>
        <label className="label mb-1 block">Base URL</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="mb-3 w-full rounded border border-edge bg-void px-3 py-2 text-ink focus:border-amber focus:outline-none"
        />
        <label className="label mb-1 block">Session token</label>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="token do serve"
          className="mb-4 w-full rounded border border-edge bg-void px-3 py-2 text-ink focus:border-amber focus:outline-none"
        />
        <button
          type="submit"
          className="w-full rounded bg-amber py-2 text-[12px] font-semibold text-void hover:brightness-110"
        >
          Conectar
        </button>
      </form>
    </div>
  )
}
