import { useMemo, useState } from 'react'
import { hasMain, invoke } from '../../lib/ipc'
import { isNoHandler, openIn, useResource, type PortInfo } from '../../lib/devtools'
import { ToolButton } from './ui'

// Aba Preview: app local num <iframe> sandboxed. URL livre (só http/https) +
// atalhos das portas em escuta (ops:ports) filtradas para servidores HTTP de
// dev comuns. Sem allow-top-navigation: a página não navega o cockpit; popups
// caem no setWindowOpenHandler do main (abre no navegador).

const URL_KEY = 'hc.devtools.preview.url'
const DEV_CMD_RE = /node|vite|next|nuxt|astro|bun|deno|python|uvicorn|gunicorn|flask|django|rails|ruby|puma|php|hugo|jekyll|caddy|nginx|httpd|java|cargo|hermes/i
const DEV_PORTS = new Set([80, 443, 3000, 3001, 4000, 4200, 4321, 5000, 5173, 5174, 8000, 8008, 8080, 8081, 8888, 9000])

function readUrl(): string {
  try {
    return localStorage.getItem(URL_KEY) ?? ''
  } catch {
    return ''
  }
}

function normalize(raw: string): string | null {
  let s = raw.trim()
  if (!s) return null
  if (/^\d+$/.test(s)) s = `http://localhost:${s}`
  else if (!/^[a-z]+:\/\//i.test(s)) s = `http://${s}`
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

async function fetchPorts(): Promise<PortInfo[] | 'no-handler'> {
  try {
    const r = await invoke<PortInfo[]>('ops:ports')
    return Array.isArray(r) ? r : []
  } catch (e) {
    if (isNoHandler(e)) return 'no-handler'
    throw e
  }
}

export function PreviewTab({ active }: { active: boolean }) {
  const [url, setUrl] = useState<string | null>(() => normalize(readUrl()))
  const [draft, setDraft] = useState(() => readUrl())
  const [nonce, setNonce] = useState(0)
  const [bad, setBad] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const ports = useResource(active && hasMain() ? 'ports' : null, fetchPorts, 10_000)

  const devPorts = useMemo(() => {
    const d = ports.data
    if (!d || d === 'no-handler') return []
    const seen = new Set<number>()
    return d
      .filter((p) => DEV_PORTS.has(p.port) || (p.port >= 1024 && p.port < 10000 && DEV_CMD_RE.test(p.command)))
      .filter((p) => (seen.has(p.port) ? false : (seen.add(p.port), true)))
      .sort((a, b) => a.port - b.port)
  }, [ports.data])

  const go = (raw: string) => {
    const u = normalize(raw)
    if (!u) {
      setBad(true)
      return
    }
    setBad(false)
    setDraft(u)
    setUrl(u)
    setLoaded(false)
    setNonce((n) => n + 1)
    try {
      localStorage.setItem(URL_KEY, u)
    } catch {
      /* sem storage */
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1"
        onSubmit={(e) => {
          e.preventDefault()
          go(draft)
        }}
      >
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setBad(false)
          }}
          placeholder="http://localhost:5173  ·  ou só a porta"
          spellCheck={false}
          className={`min-w-0 flex-1 rounded border bg-void px-2 py-1 text-[11px] text-ink outline-none focus:border-amber/60 ${
            bad ? 'border-alert/60' : 'border-edge'
          }`}
        />
        <ToolButton title="recarregar" disabled={!url} onClick={() => url && (setLoaded(false), setNonce((n) => n + 1))}>
          ↻
        </ToolButton>
        <ToolButton title="abrir no navegador" disabled={!url} onClick={() => url && void openIn({ kind: 'url', url })}>
          externo
        </ToolButton>
      </form>

      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-edge px-2 py-1 text-[10px]">
        <span className="label shrink-0 text-faint">portas</span>
        {!hasMain() ? (
          <span className="text-faint">indisponível fora do app</span>
        ) : ports.data === 'no-handler' ? (
          <span className="text-faint">ops:ports ainda não disponível</span>
        ) : ports.error && !ports.data ? (
          <span className="truncate text-alert" title={ports.error}>
            erro: {ports.error}
          </span>
        ) : !ports.data ? (
          <span className="hc-shimmer text-faint">lendo portas…</span>
        ) : devPorts.length === 0 ? (
          <span className="text-faint">nenhum servidor local em escuta</span>
        ) : (
          devPorts.map((p) => {
            const u = `http://localhost:${p.port}/`
            const on = url?.startsWith(`http://localhost:${p.port}`)
            return (
              <button
                key={p.port}
                type="button"
                onClick={() => go(u)}
                title={`${p.command} · pid ${p.pid} · ${p.address}`}
                className={`shrink-0 rounded border px-1.5 py-0.5 ${
                  on ? 'border-amber/50 text-amber' : 'border-edge text-dim hover:border-edge2 hover:text-ink'
                }`}
              >
                :{p.port} <span className="text-faint">{p.command.split('/').pop()?.slice(0, 14)}</span>
              </button>
            )
          })
        )}
      </div>

      <div className="relative min-h-0 flex-1 bg-white/[0.02]">
        {url ? (
          <>
            <iframe
              key={`${url}#${nonce}`}
              src={url}
              title="preview"
              onLoad={() => setLoaded(true)}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
              referrerPolicy="no-referrer"
              className="h-full w-full border-0 bg-white"
            />
            {!loaded && (
              <div className="hc-shimmer pointer-events-none absolute inset-x-0 top-0 px-3 py-1 text-[10px] text-faint">
                carregando {url}…
              </div>
            )}
          </>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-[11px] leading-relaxed text-faint">
            informe a URL de um app local ou escolha uma porta acima.
            <br />
            se a página ficar em branco, o app pode bloquear iframe (X-Frame-Options/CSP) — use “externo”.
          </div>
        )}
      </div>
    </div>
  )
}
