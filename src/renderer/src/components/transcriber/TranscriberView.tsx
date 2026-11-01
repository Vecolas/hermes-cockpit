import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { toast } from '../../lib/toast'
import { useViewActive } from '../layout/views'
import {
  LANGUAGES,
  LiveSession,
  addHistory,
  clearHistory,
  errMsg,
  fmtClock,
  loadHistory,
  parseSrt,
  removeHistory,
  subscribeHistory,
  transcriber,
  type HistoryItem,
  type LiveSource,
  type TranscribeResult,
  type TranscriberStatus,
} from '../../lib/transcriber'

// Transcriber (área central): serviço local ~/dev/transcriber (Whisper via MLX).
// CONTRATO: nome do export e props são fixos (App/registry já montam assim).

type Tab = 'arquivo' | 'youtube' | 'live' | 'historico'
const TABS: { id: Tab; label: string }[] = [
  { id: 'arquivo', label: 'Arquivo' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'live', label: 'Tempo real' },
  { id: 'historico', label: 'Histórico' },
]

export function TranscriberView() {
  const [tab, setTab] = useState<Tab>('arquivo')
  const svc = useService()

  return (
    <div className="flex h-full min-h-0 flex-col bg-void">
      <ServiceBar svc={svc} />
      <nav className="flex shrink-0 items-center gap-1 border-b border-edge px-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-[10px] font-semibold tracking-[0.14em] uppercase transition-colors ${
              tab === t.id ? 'border-amber text-ink' : 'border-transparent text-faint hover:text-dim'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* abas ficam montadas: trocar de aba não derruba uma sessão ao vivo nem um upload */}
        <div className={tab === 'arquivo' ? 'hc-fade-in' : 'hidden'}>
          <FileTab ready={svc.usable} />
        </div>
        <div className={tab === 'youtube' ? 'hc-fade-in' : 'hidden'}>
          <YoutubeTab ready={svc.usable} />
        </div>
        <div className={tab === 'live' ? 'hc-fade-in' : 'hidden'}>
          <LiveTab ready={svc.usable} />
        </div>
        <div className={tab === 'historico' ? 'hc-fade-in' : 'hidden'}>
          <HistoryTab />
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------- serviço ---

interface Service {
  status: TranscriberStatus | null
  error: string | null
  busy: 'start' | 'stop' | null
  /** instalado (pode subir sob demanda) */
  usable: boolean
  refresh(): void
  start(): void
  stop(): void
}

function useService(): Service {
  const [status, setStatus] = useState<TranscriberStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null)

  const refresh = useCallback(() => {
    if (!transcriber.available()) {
      setError('indisponível fora do app (sem main process)')
      return
    }
    transcriber
      .status()
      .then((s) => {
        setStatus(s)
        setError(null)
      })
      .catch((e: unknown) => setError(errMsg(e)))
  }, [])

  useEffect(() => {
    refresh()
    const off = transcriber.onStatus(setStatus)
    return off
  }, [refresh])

  // poll: rápido enquanto o modelo carrega/sobe, lento no resto
  const fast = Boolean(status?.starting || status?.model?.loading || (status?.running && !status.model?.loaded))
  // view escondida (keep-alive): pausa o polling; o push transcriber:status segue valendo
  const viewActive = useViewActive()
  useEffect(() => {
    if (!viewActive) return
    const t = setInterval(refresh, fast ? 1500 : 8000)
    return () => clearInterval(t)
  }, [fast, refresh, viewActive])

  const start = useCallback(() => {
    setBusy('start')
    transcriber
      .start()
      .then((s) => {
        setStatus(s)
        toast({ title: 'Transcriber online', detail: s.ours ? `pid ${s.pid ?? '?'}` : 'reutilizando serviço já ativo', tone: 'ok' })
      })
      .catch((e: unknown) => toast({ title: 'Transcriber não subiu', detail: errMsg(e), tone: 'error' }))
      .finally(() => {
        setBusy(null)
        refresh()
      })
  }, [refresh])

  const stop = useCallback(() => {
    setBusy('stop')
    transcriber
      .stop()
      .then(setStatus)
      .catch((e: unknown) => toast({ title: 'Não parei o transcriber', detail: errMsg(e), tone: 'warn' }))
      .finally(() => {
        setBusy(null)
        refresh()
      })
  }, [refresh])

  const usable = Boolean(status?.installed && status.venv) || Boolean(status?.running)
  return { status, error, busy, usable, refresh, start, stop }
}

function ServiceBar({ svc }: { svc: Service }) {
  const { status: s, error, busy } = svc
  const [showLogs, setShowLogs] = useState(false)

  let dot = 'bg-faint'
  let label = 'verificando…'
  if (error) {
    dot = 'bg-alert'
    label = error
  } else if (s) {
    if (!s.installed) {
      dot = 'bg-alert'
      label = `não encontrado em ${s.repo}`
    } else if (!s.venv && !s.running) {
      dot = 'bg-alert'
      label = 'venv ausente (.venv/bin/python)'
    } else if (s.starting || busy === 'start') {
      dot = 'bg-amber hc-pulse-dot'
      label = 'subindo…'
    } else if (s.running) {
      dot = s.model?.loaded ? 'bg-phos' : s.model?.error ? 'bg-alert' : 'bg-amber hc-pulse-dot'
      label = s.ours ? `online · pid ${s.pid ?? '?'}` : 'online · externo'
    } else {
      label = s.error ? s.error : 'parado'
      dot = s.error ? 'bg-alert' : 'bg-faint'
    }
  }

  const model = s?.model
  const modelLabel = !s?.running
    ? null
    : model?.error
      ? `modelo: erro — ${model.error}`
      : model?.loaded
        ? 'modelo pronto'
        : 'carregando modelo…'

  return (
    <header className="shrink-0 border-b border-edge bg-panel">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
        <span className="text-[11px] font-semibold tracking-[0.18em] text-ink uppercase">Transcriber</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-dim">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
          <span className="truncate" title={label}>
            {label}
          </span>
        </span>
        {modelLabel && (
          <span
            className={`truncate rounded border px-1.5 py-px text-[10px] ${
              model?.error ? 'border-alert/40 text-alert' : model?.loaded ? 'border-phos/30 text-phos' : 'border-amber/30 text-amber'
            }`}
            title={model?.name}
          >
            {modelLabel}
            {model?.name && <span className="ml-1 text-faint">{model.name.split('/').pop()}</span>}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <SmallBtn onClick={() => setShowLogs((v) => !v)} active={showLogs}>
            logs
          </SmallBtn>
          <SmallBtn onClick={svc.refresh}>↻</SmallBtn>
          {s?.running ? (
            s.ours ? (
              <ConfirmBtn onConfirm={svc.stop} disabled={busy !== null} label="parar" confirmLabel="confirmar parada?" />
            ) : (
              <span className="text-[10px] text-faint" title="iniciado fora do cockpit — não é parado por aqui">
                externo
              </span>
            )
          ) : (
            <SmallBtn
              onClick={svc.start}
              disabled={busy !== null || Boolean(s?.starting) || !svc.usable}
              tone="amber"
            >
              {busy === 'start' || s?.starting ? 'subindo…' : 'iniciar'}
            </SmallBtn>
          )}
        </div>
      </div>
      {(s?.starting || busy === 'start' || (s?.running && !model?.loaded && !model?.error)) && (
        <div className="hc-shimmer h-px w-full bg-amber/30" aria-hidden />
      )}
      {showLogs && <LogsPanel />}
    </header>
  )
}

function LogsPanel() {
  const [lines, setLines] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const box = useRef<HTMLPreElement>(null)
  const viewActive = useViewActive()
  useEffect(() => {
    if (!viewActive) return
    let alive = true
    const load = () =>
      transcriber
        .logs()
        .then((l) => {
          if (!alive) return
          setLines(l)
          setErr(null)
        })
        .catch((e: unknown) => alive && setErr(errMsg(e)))
    load()
    const t = setInterval(load, 2000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [viewActive])
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight })
  }, [lines])
  return (
    <pre
      ref={box}
      className="hc-fade-in max-h-40 overflow-auto border-t border-edge bg-void px-4 py-2 text-[10px] leading-relaxed whitespace-pre-wrap text-dim"
    >
      {err ? <span className="text-alert">erro: {err}</span> : lines == null ? 'carregando…' : lines.length ? lines.join('\n') : 'sem logs (o serviço não foi iniciado por este app)'}
    </pre>
  )
}

// ------------------------------------------------------------- primitivos ---

function SmallBtn({
  children,
  onClick,
  disabled,
  active,
  tone,
  title,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  tone?: 'amber' | 'alert' | 'phos'
  title?: string
}) {
  const toneCls =
    tone === 'amber'
      ? 'border-amber/50 text-amber hover:bg-amber/10'
      : tone === 'alert'
        ? 'border-alert/50 text-alert hover:bg-alert/10'
        : tone === 'phos'
          ? 'border-phos/40 text-phos hover:bg-phos/10'
          : active
            ? 'border-edge2 bg-panel2 text-ink'
            : 'border-edge2 text-dim hover:border-edge2 hover:text-ink'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded border px-2 py-0.5 text-[10px] tracking-[0.1em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${toneCls}`}
    >
      {children}
    </button>
  )
}

/** Confirmação inline em 2 cliques (sem dialogs bloqueantes). */
function ConfirmBtn({
  onConfirm,
  label,
  confirmLabel = 'confirmar?',
  disabled,
}: {
  onConfirm: () => void
  label: string
  confirmLabel?: string
  disabled?: boolean
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3500)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <SmallBtn
      tone="alert"
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else setArmed(true)
      }}
    >
      {armed ? confirmLabel : label}
    </SmallBtn>
  )
}

function LangSelect({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-1.5 text-[10px] tracking-[0.12em] text-faint uppercase">
      idioma
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-edge2 bg-panel2 px-1.5 py-0.5 text-[11px] tracking-normal text-ink normal-case outline-none focus:border-amber/60"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function useElapsed(running: boolean): number {
  const [t0, setT0] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running) {
      setT0(null)
      return
    }
    const start = Date.now()
    setT0(start)
    setNow(start)
    const i = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(i)
  }, [running])
  return t0 == null ? 0 : (now - t0) / 1000
}

function Working({ phase, elapsed }: { phase: string; elapsed: number }) {
  return (
    <div className="hc-fade-in mt-4 rounded border border-edge bg-panel px-3 py-2.5">
      <div className="flex items-center gap-2 text-[11px] text-dim">
        <span className="hc-pulse-dot h-1.5 w-1.5 rounded-full bg-amber" aria-hidden />
        <span>{phase}</span>
        <span className="ml-auto tabular-nums text-faint">{fmtClock(elapsed)}</span>
      </div>
      <div className="hc-shimmer mt-2 h-1 w-full overflow-hidden rounded-full bg-edge" aria-hidden />
      <div className="mt-1.5 text-[10px] text-faint">o servidor não informa progresso — tempo decorrido (≈20–30× tempo real)</div>
    </div>
  )
}

function ErrorBox({ msg }: { msg: string }) {
  return <div className="hc-fade-in mt-4 rounded border border-alert/40 bg-alert/5 px-3 py-2 text-[11px] text-alert">{msg}</div>
}

function copy(text: string, what = 'Texto copiado'): void {
  navigator.clipboard
    .writeText(text)
    .then(() => toast({ title: what, tone: 'ok', durationMs: 2000 }))
    .catch((e: unknown) => toast({ title: 'Não copiei', detail: errMsg(e), tone: 'error' }))
}

function stem(title: string): string {
  return (title.replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_').trim() || 'transcricao').slice(0, 80)
}

function download(name: string, content: string): void {
  transcriber
    .save(name, content)
    .then((p) => p && toast({ title: 'Salvo', detail: p, tone: 'ok' }))
    .catch((e: unknown) => toast({ title: 'Não salvei', detail: errMsg(e), tone: 'error' }))
}

// -------------------------------------------------------------- resultado ---

function ResultView({ title, result }: { title: string; result: Pick<TranscribeResult, 'text' | 'srt' | 'language'> }) {
  const segs = result.srt ? parseSrt(result.srt) : []
  const [mode, setMode] = useState<'segmentos' | 'texto'>(segs.length ? 'segmentos' : 'texto')
  const words = result.text.trim() ? result.text.trim().split(/\s+/).length : 0
  return (
    <section className="hc-rise mt-4 rounded border border-edge bg-panel">
      <header className="flex flex-wrap items-center gap-2 border-b border-edge px-3 py-2">
        <span className="min-w-0 truncate text-[11px] text-ink" title={title}>
          {title}
        </span>
        <span className="text-[10px] text-faint">
          {result.language ?? '?'} · {words} palavras{segs.length ? ` · ${segs.length} segmentos` : ''}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {segs.length > 0 && (
            <SmallBtn onClick={() => setMode((m) => (m === 'texto' ? 'segmentos' : 'texto'))}>
              {mode === 'texto' ? 'timestamps' : 'texto corrido'}
            </SmallBtn>
          )}
          <SmallBtn onClick={() => copy(result.text)} disabled={!result.text}>
            copiar
          </SmallBtn>
          <SmallBtn onClick={() => download(`${stem(title)}.txt`, result.text)} disabled={!result.text}>
            .txt
          </SmallBtn>
          <SmallBtn onClick={() => download(`${stem(title)}.srt`, result.srt)} disabled={!result.srt}>
            .srt
          </SmallBtn>
          <SmallBtn
            tone="amber"
            disabled={!result.text}
            onClick={() =>
              navigator.clipboard
                .writeText(result.text)
                .then(() => toast({ title: 'Pronto para o chat', detail: 'transcrição copiada — cole no composer (⌘V)', tone: 'info' }))
                .catch((e: unknown) => toast({ title: 'Não copiei', detail: errMsg(e), tone: 'error' }))
            }
          >
            mandar p/ chat
          </SmallBtn>
        </div>
      </header>
      <div className="max-h-[50vh] overflow-y-auto px-3 py-2.5 text-[12px] leading-relaxed text-ink">
        {!result.text ? (
          <span className="text-faint">sem fala detectada</span>
        ) : mode === 'texto' || !segs.length ? (
          <p className="whitespace-pre-wrap select-text">{result.text}</p>
        ) : (
          <ol className="space-y-1">
            {segs.map((s, i) => (
              <li key={i} className="flex gap-3">
                <button
                  type="button"
                  onClick={() => copy(`[${fmtClock(s.start)}] ${s.text}`, 'Segmento copiado')}
                  className="shrink-0 pt-px text-[10px] tabular-nums text-cyanic/80 hover:text-cyanic"
                  title="copiar segmento"
                >
                  {fmtClock(s.start)}
                </button>
                <span className="select-text">{s.text}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- arquivo ---

const BIG_BYTES = 1024 * 1024 * 1024

function FileTab({ ready }: { ready: boolean }) {
  const [lang, setLang] = useState('auto')
  const [drag, setDrag] = useState(false)
  const [phase, setPhase] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [res, setRes] = useState<{ title: string; result: TranscribeResult } | null>(null)
  const elapsed = useElapsed(phase !== null)

  const run = async (title: string, job: () => Promise<TranscribeResult>) => {
    setError(null)
    setRes(null)
    setPhase(`transcrevendo ${title}…`)
    try {
      const result = await job()
      setRes({ title, result })
      addHistory({ title, kind: 'arquivo', language: result.language, text: result.text, srt: result.srt })
      toast({ title: 'Transcrição pronta', detail: title, tone: 'ok' })
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setPhase(null)
    }
  }

  const onFile = (f: File) => {
    if (f.size > BIG_BYTES) {
      setError(`arquivo grande (${(f.size / 1e9).toFixed(1)} GB) — use "escolher arquivo", que envia do disco sem passar pela memória da UI`)
      return
    }
    void run(f.name, async () => {
      setPhase(`lendo ${f.name}…`)
      const buf = await f.arrayBuffer()
      setPhase(`transcrevendo ${f.name}…`)
      return transcriber.uploadBytes(buf, f.name, lang)
    })
  }

  const pick = () => {
    transcriber
      .pickFile()
      .then((p) => {
        if (p) void run(p.split('/').pop() || p, () => transcriber.uploadPath(p, lang))
      })
      .catch((e: unknown) => setError(errMsg(e)))
  }

  const busy = phase !== null
  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          if (!busy) setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          const f = e.dataTransfer.files[0]
          if (f && !busy && ready) onFile(f)
        }}
        className={`flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-10 text-center transition-colors ${
          drag ? 'hc-glow-amber border-amber bg-amber/5' : 'border-edge2 bg-panel/60'
        } ${busy || !ready ? 'opacity-60' : ''}`}
      >
        <span className="text-[10px] tracking-[0.18em] text-faint uppercase">arraste áudio ou vídeo aqui</span>
        <span className="text-[11px] text-dim">mp3 · wav · m4a · mp4 · mkv · mov · webm…</span>
        <div className="mt-2 flex items-center gap-3">
          <SmallBtn tone="amber" onClick={pick} disabled={busy || !ready}>
            escolher arquivo
          </SmallBtn>
          <LangSelect value={lang} onChange={setLang} disabled={busy} />
        </div>
        {!ready && <span className="text-[10px] text-alert">transcriber não instalado</span>}
      </div>
      {phase && <Working phase={phase} elapsed={elapsed} />}
      {error && <ErrorBox msg={error} />}
      {res && <ResultView title={res.title} result={res.result} />}
    </div>
  )
}

// ---------------------------------------------------------------- youtube ---

function YoutubeTab({ ready }: { ready: boolean }) {
  const [url, setUrl] = useState('')
  const [lang, setLang] = useState('auto')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [res, setRes] = useState<{ title: string; result: TranscribeResult } | null>(null)
  const elapsed = useElapsed(busy)
  const valid = /^https?:\/\/\S+$/i.test(url.trim())

  const go = () => {
    if (!valid || busy) return
    const u = url.trim()
    setBusy(true)
    setError(null)
    setRes(null)
    transcriber
      .youtube(u, lang)
      .then((result) => {
        setRes({ title: u, result })
        addHistory({ title: u, kind: 'youtube', language: result.language, text: result.text, srt: result.srt })
        toast({ title: 'Transcrição pronta', detail: u, tone: 'ok' })
      })
      .catch((e: unknown) => setError(errMsg(e)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          go()
        }}
        className="flex flex-wrap items-center gap-2 rounded-md border border-edge bg-panel px-3 py-3"
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          disabled={busy}
          className="min-w-[220px] flex-1 rounded border border-edge2 bg-void px-2 py-1 text-[12px] text-ink outline-none placeholder:text-faint focus:border-amber/60"
        />
        <LangSelect value={lang} onChange={setLang} disabled={busy} />
        <button
          type="submit"
          disabled={!valid || busy || !ready}
          className="rounded border border-amber/50 px-3 py-1 text-[10px] tracking-[0.12em] text-amber uppercase hover:bg-amber/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          transcrever
        </button>
      </form>
      <p className="mt-1.5 text-[10px] text-faint">áudio extraído com yt-dlp no servidor; qualquer link suportado pelo yt-dlp funciona.</p>
      {busy && <Working phase="baixando áudio e transcrevendo…" elapsed={elapsed} />}
      {error && <ErrorBox msg={error} />}
      {res && <ResultView title={res.title} result={res.result} />}
    </div>
  )
}

// ------------------------------------------------------------- tempo real ---

const SOURCES: { id: LiveSource; label: string; hint: string }[] = [
  { id: 'mic', label: 'Microfone', hint: 'capturado aqui no app' },
  { id: 'system', label: 'Sistema', hint: 'BlackHole 2ch, capturado no servidor' },
  { id: 'both', label: 'Sistema + mic', hint: 'mixado no servidor' },
]

function LiveTab({ ready }: { ready: boolean }) {
  const [source, setSource] = useState<LiveSource>('mic')
  const [lang, setLang] = useState('auto')
  const [state, setState] = useState<'idle' | 'starting' | 'live' | 'finishing'>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [blackhole, setBlackhole] = useState<boolean | null>(null)
  const [devErr, setDevErr] = useState<string | null>(null)
  const [lastAt, setLastAt] = useState(0)
  const levelRef = useRef(0)
  const session = useRef<LiveSession | null>(null)
  const textRef = useRef('')
  const outRef = useRef<HTMLDivElement>(null)
  const elapsed = useElapsed(state === 'live' || state === 'finishing')

  useEffect(() => () => session.current?.abort(), [])

  useEffect(() => {
    if (source === 'mic' || !ready) return
    let alive = true
    setBlackhole(null)
    setDevErr(null)
    transcriber
      .devices()
      .then((d) => alive && setBlackhole(d.blackhole))
      .catch((e: unknown) => {
        if (!alive) return
        setBlackhole(null)
        setDevErr(`não consegui listar dispositivos de áudio: ${errMsg(e)}`)
      })
    return () => {
      alive = false
    }
  }, [source, ready])

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [text])

  const start = () => {
    setError(null)
    setText('')
    textRef.current = ''
    setState('starting')
    const s = new LiveSession(source, lang, {
      onText: (t) => {
        textRef.current = textRef.current ? `${textRef.current} ${t}` : t
        setText(textRef.current)
        setLastAt(Date.now())
      },
      onLevel: (l) => {
        levelRef.current = l
      },
      onError: (m) => setError(m),
      onEnd: () => {
        if (session.current === s) session.current = null
        setState('idle')
        const final = textRef.current.trim()
        if (final) {
          const label = SOURCES.find((x) => x.id === source)?.label ?? source
          addHistory({
            title: `${label} · ${new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`,
            kind: 'ao vivo',
            language: lang === 'auto' ? null : lang,
            text: final,
            srt: '',
          })
        }
      },
    })
    session.current = s
    s.start()
      .then(() => session.current === s && setState('live'))
      .catch((e: unknown) => {
        if (session.current === s) session.current = null
        setError(errMsg(e))
        setState('idle')
      })
  }

  const stop = () => {
    setState('finishing')
    session.current?.stop()
  }

  const active = state !== 'idle'
  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-edge bg-panel px-3 py-3">
        <div className="flex overflow-hidden rounded border border-edge2">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={active}
              onClick={() => setSource(s.id)}
              title={s.hint}
              className={`px-2.5 py-1 text-[10px] tracking-[0.1em] uppercase transition-colors disabled:cursor-not-allowed ${
                source === s.id ? 'bg-panel2 text-ink' : 'text-faint hover:text-dim'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <LangSelect value={lang} onChange={setLang} disabled={active} />
        <div className="ml-auto flex items-center gap-2">
          {active && <span className="text-[11px] tabular-nums text-dim">{fmtClock(elapsed)}</span>}
          {state === 'idle' ? (
            <SmallBtn tone="amber" onClick={start} disabled={!ready || (source !== 'mic' && blackhole === false)}>
              ● gravar
            </SmallBtn>
          ) : (
            <SmallBtn tone="alert" onClick={stop} disabled={state !== 'live'}>
              {state === 'starting' ? 'abrindo…' : state === 'finishing' ? 'finalizando…' : '■ parar'}
            </SmallBtn>
          )}
        </div>
      </div>

      {source !== 'mic' && devErr && <ErrorBox msg={devErr} />}
      {source !== 'mic' && blackhole === false && (
        <ErrorBox msg="BlackHole 2ch não encontrado. Instale com `brew install --cask blackhole-2ch` e crie um Multi-Output Device (alto-falantes + BlackHole) no Audio MIDI Setup." />
      )}

      <div className="mt-4 flex items-center gap-3">
        <span className={`h-2 w-2 rounded-full ${state === 'live' ? 'hc-pulse-dot bg-alert' : 'bg-faint'}`} aria-hidden />
        {source === 'mic' ? (
          <LevelMeter levelRef={levelRef} active={state === 'live'} />
        ) : (
          <span className="text-[10px] text-faint">captura no servidor — sem medidor de nível aqui</span>
        )}
        {state === 'live' && (
          <span className="shrink-0 text-[10px] text-faint">
            {lastAt ? `último trecho há ${Math.max(0, Math.round((Date.now() - lastAt) / 1000))}s` : 'aguardando 1ª janela (~4s)'}
          </span>
        )}
      </div>

      {error && <ErrorBox msg={error} />}

      <div
        ref={outRef}
        className={`mt-3 max-h-[48vh] min-h-32 overflow-y-auto rounded border bg-panel px-3 py-2.5 text-[13px] leading-relaxed ${
          state === 'live' ? 'border-amber/40' : 'border-edge'
        }`}
      >
        {text ? (
          <p className="whitespace-pre-wrap text-ink select-text">
            {text}
            {state === 'live' && <span className="hc-pulse-dot ml-1 inline-block h-3 w-1.5 translate-y-0.5 bg-amber/70" aria-hidden />}
          </p>
        ) : (
          <span className="text-[11px] text-faint">
            {state === 'live' ? 'ouvindo… o texto aparece em janelas de ~4 segundos' : 'texto aparece aqui durante a gravação'}
          </span>
        )}
      </div>
      {text && state === 'idle' && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <SmallBtn onClick={() => copy(text)}>copiar</SmallBtn>
          <SmallBtn onClick={() => download(`ao-vivo-${Date.now()}.txt`, text)}>.txt</SmallBtn>
          <SmallBtn
            tone="amber"
            onClick={() =>
              navigator.clipboard
                .writeText(text)
                .then(() => toast({ title: 'Pronto para o chat', detail: 'transcrição copiada — cole no composer (⌘V)', tone: 'info' }))
                .catch((e: unknown) => toast({ title: 'Não copiei', detail: errMsg(e), tone: 'error' }))
            }
          >
            mandar p/ chat
          </SmallBtn>
        </div>
      )}
    </div>
  )
}

/** Barras de nível animadas por rAF direto no DOM (sem re-render por frame). */
function LevelMeter({ levelRef, active }: { levelRef: RefObject<number>; active: boolean }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  const N = 24
  useEffect(() => {
    let raf = 0
    const hist: number[] = Array(N).fill(0)
    const tick = () => {
      hist.push(active ? levelRef.current : 0)
      hist.shift()
      for (let i = 0; i < N; i++) {
        const el = bars.current[i]
        if (el) {
          const v = hist[i]
          el.style.transform = `scaleY(${Math.max(0.08, v)})`
          el.style.opacity = String(0.35 + v * 0.65)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, levelRef])
  return (
    <div className="flex h-6 flex-1 items-center gap-[3px]" aria-label="nível do microfone">
      {Array.from({ length: N }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el
          }}
          className={`h-full w-1 origin-center rounded-full transition-transform duration-75 ${active ? 'bg-phos' : 'bg-edge2'}`}
          style={{ transform: 'scaleY(0.08)' }}
        />
      ))}
    </div>
  )
}

// -------------------------------------------------------------- histórico ---

function HistoryTab() {
  const [items, setItems] = useState<HistoryItem[]>(() => loadHistory())
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => subscribeHistory(setItems), [])
  const sel = items.find((x) => x.id === open) ?? null

  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] tracking-[0.16em] text-faint uppercase">últimos {items.length}/20 · só neste computador</span>
        {items.length > 0 && (
          <div className="ml-auto">
            <ConfirmBtn label="limpar tudo" confirmLabel="apagar todos?" onConfirm={clearHistory} />
          </div>
        )}
      </div>
      {!items.length ? (
        <div className="rounded border border-edge bg-panel px-3 py-6 text-center text-[11px] text-faint">nenhuma transcrição ainda</div>
      ) : (
        <ul className="divide-y divide-edge overflow-hidden rounded border border-edge bg-panel">
          {items.map((it) => (
            <li key={it.id} className={open === it.id ? 'bg-panel2' : ''}>
              <div className="flex items-center gap-3 px-3 py-2">
                <button type="button" onClick={() => setOpen(open === it.id ? null : it.id)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-[12px] text-ink">{it.title}</div>
                  <div className="truncate text-[10px] text-faint">
                    <span className="tracking-[0.1em] uppercase">{it.kind}</span> ·{' '}
                    {new Date(it.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · {it.language ?? '?'} ·{' '}
                    {it.text.slice(0, 80)}
                  </div>
                </button>
                <ConfirmBtn label="apagar" confirmLabel="apagar?" onConfirm={() => removeHistory(it.id)} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {sel && <ResultView key={sel.id} title={sel.title} result={sel} />}
    </div>
  )
}
