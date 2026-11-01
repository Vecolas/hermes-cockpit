import { hasMain, invoke, onMain } from './ipc'

// Cliente do transcriber local (~/dev/transcriber). Tudo passa pelo main
// (src/main/ipc/transcriber.ts): o server.py não tem CORS e o renderer
// empacotado roda em file://. Formato do tempo real (lido do server.py):
//   - source=mic: o CLIENTE manda chunks webm/opus (MediaRecorder, timeslice
//     500ms) como binário; o server acumula, decodifica com ffmpeg para 16 kHz
//     mono float32 e transcreve janelas de ~4s (0.5s de sobreposição).
//   - source=system|both: o SERVER captura BlackHole (e o mic default) via
//     ffmpeg avfoundation; o cliente não manda áudio.
//   - server → cliente: {type:'append', text} (texto confirmado, já sem
//     duplicatas de borda), {type:'error', text}, {type:'done'} após
//     {type:'stop'} do cliente. Não há parciais.

export interface ModelState {
  name: string
  loaded: boolean
  loading: boolean
  error: string | null
}

export interface TranscriberStatus {
  installed: boolean
  venv: boolean
  running: boolean
  ours: boolean
  starting: boolean
  pid?: number
  url: string
  repo: string
  model?: ModelState
  error?: string
}

export interface TranscribeResult {
  text: string
  language: string | null
  srt: string
}

export type LiveSource = 'mic' | 'system' | 'both'

export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'auto', label: 'auto' },
  { code: 'pt', label: 'português' },
  { code: 'en', label: 'inglês' },
  { code: 'es', label: 'espanhol' },
  { code: 'fr', label: 'francês' },
  { code: 'de', label: 'alemão' },
  { code: 'it', label: 'italiano' },
  { code: 'ja', label: 'japonês' },
  { code: 'zh', label: 'chinês' },
]

// ------------------------------------------------------------------ IPC ---

export const transcriber = {
  available: hasMain,
  status: () => invoke<TranscriberStatus>('transcriber:status'),
  start: () => invoke<TranscriberStatus>('transcriber:start'),
  stop: () => invoke<TranscriberStatus>('transcriber:stop'),
  logs: () => invoke<string[]>('transcriber:logs'),
  devices: () => invoke<{ devices: string[]; blackhole: boolean }>('transcriber:devices'),
  pickFile: () => invoke<string | null>('transcriber:pickFile'),
  uploadPath: (path: string, language: string) => invoke<TranscribeResult>('transcriber:upload', { path, language }),
  uploadBytes: (bytes: ArrayBuffer, name: string, language: string) =>
    invoke<TranscribeResult>('transcriber:upload', { bytes, name, language }),
  youtube: (url: string, language: string) => invoke<TranscribeResult>('transcriber:youtube', { url, language }),
  save: (name: string, content: string) => invoke<string | null>('transcriber:save', { name, content }),
  onStatus: (fn: (s: TranscriberStatus) => void) => onMain<TranscriberStatus>('transcriber:status', fn),
}

export function errMsg(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err)
  // Electron prefixa "Error invoking remote method 'x': Error: ..."
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

// ----------------------------------------------------------- tempo real ---

type LiveEvent =
  | { id: string; kind: 'state'; state: 'open' | 'error' | 'closed'; message?: string }
  | { id: string; kind: 'msg'; msg: { type: string; text?: string } }

export interface LiveHandlers {
  onText(text: string): void
  onLevel?(level: number): void
  onError(message: string): void
  /** sessão encerrada (após stop + done, ou queda) */
  onEnd(): void
}

let liveSeq = 0

/**
 * Sessão de tempo real. mic: getUserMedia + MediaRecorder(webm/opus, 500ms)
 * → transcriber:liveSend. system/both: captura no server (sem áudio daqui).
 */
export class LiveSession {
  readonly id = `live-${Date.now().toString(36)}-${++liveSeq}`
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private audioCtx: AudioContext | null = null
  private raf = 0
  private unsub: (() => void) | null = null
  private ended = false
  /** start() ainda não terminou (getUserMedia / liveOpen pendentes). */
  private starting = false
  private stopTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly source: LiveSource,
    private readonly language: string,
    private readonly h: LiveHandlers,
  ) {}

  async start(): Promise<void> {
    if (!hasMain()) throw new Error('tempo real indisponível fora do app')
    if (this.ended) return
    this.starting = true
    try {
      await this.doStart()
    } finally {
      this.starting = false
    }
  }

  /** Abortado (teardown/stop) enquanto start() aguardava: libera o que chegou tarde. */
  private bailIfEnded(stream?: MediaStream | null): boolean {
    if (!this.ended) return false
    stream?.getTracks().forEach((t) => t.stop())
    void invoke('transcriber:liveClose', this.id).catch(() => {})
    return true
  }

  private async doStart(): Promise<void> {
    if (this.source === 'mic') {
      if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        throw new Error('MediaRecorder sem suporte a audio/webm;codecs=opus')
      }
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        })
      } catch (err) {
        if (this.ended) return
        throw new Error(`microfone negado ou indisponível: ${errMsg(err)} (Ajustes › Privacidade › Microfone)`)
      }
      if (this.bailIfEnded(stream)) return
      this.stream = stream
      this.meter(stream)
    }

    this.unsub = onMain<LiveEvent>('transcriber:live', (ev) => {
      if (ev.id !== this.id) return
      if (ev.kind === 'msg') {
        const t = ev.msg.type
        if (t === 'append' && ev.msg.text) this.h.onText(ev.msg.text)
        else if (t === 'error') {
          this.h.onError(ev.msg.text || 'erro do transcriber')
          this.teardown()
        } else if (t === 'done') this.teardown()
      } else if (ev.state === 'error') {
        this.h.onError(ev.message || 'erro no WebSocket')
      } else if (ev.state === 'closed') {
        this.teardown()
      }
    })

    const r = await invoke<{ ok: boolean; error?: string }>('transcriber:liveOpen', {
      id: this.id,
      language: this.language,
      source: this.source,
    })
    // teardown() já rodou durante o await: o WS acabou de abrir no main e o
    // stream (se houver) ainda está vivo — fecha os dois.
    if (this.bailIfEnded(this.stream)) return
    if (!r.ok) {
      this.teardown(true)
      throw new Error(r.error || 'falha ao abrir sessão ao vivo')
    }

    if (this.stream) {
      const rec = new MediaRecorder(this.stream, { mimeType: 'audio/webm;codecs=opus' })
      rec.ondataavailable = (e) => {
        if (e.data.size === 0 || this.ended) return
        void e.data.arrayBuffer().then((buf) => invoke('transcriber:liveSend', this.id, buf).catch(() => {}))
      }
      rec.start(500)
      this.recorder = rec
    }
  }

  /** Para a captura; o server transcreve o resto e responde 'done'. */
  stop(): void {
    if (this.ended) return
    // Ainda abrindo (prompt do mic / liveOpen): nada gravado, encerra de vez.
    if (this.starting) {
      this.teardown()
      return
    }
    const finish = () => {
      void invoke('transcriber:liveSend', this.id, JSON.stringify({ type: 'stop' })).catch(() => {})
      // salvaguarda: se o 'done' não vier (server travado), encerra mesmo assim
      this.stopTimer = setTimeout(() => this.teardown(), 15_000)
    }
    this.releaseMedia()
    if (this.recorder && this.recorder.state !== 'inactive') {
      const rec = this.recorder
      rec.onstop = () => setTimeout(finish, 50)
      rec.stop()
    } else finish()
  }

  /** Aborta sem esperar o resto da transcrição. */
  abort(): void {
    this.teardown()
  }

  private meter(stream: MediaStream): void {
    if (!this.h.onLevel) return
    try {
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(stream)
      const an = ctx.createAnalyser()
      an.fftSize = 1024
      src.connect(an)
      const data = new Float32Array(an.fftSize)
      const tick = () => {
        an.getFloatTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
        const rms = Math.sqrt(sum / data.length)
        this.h.onLevel?.(Math.min(1, rms * 6))
        this.raf = requestAnimationFrame(tick)
      }
      this.audioCtx = ctx
      tick()
    } catch {
      /* medidor é cosmético */
    }
  }

  private releaseMedia(): void {
    cancelAnimationFrame(this.raf)
    this.h.onLevel?.(0)
    void this.audioCtx?.close().catch(() => {})
    this.audioCtx = null
    if (this.recorder && this.recorder.state !== 'inactive' && this.ended) this.recorder.stop()
    // as tracks param depois do recorder emitir o último chunk
    setTimeout(() => this.stream?.getTracks().forEach((t) => t.stop()), 100)
  }

  private teardown(silent = false): void {
    if (this.ended) return
    this.ended = true
    if (this.stopTimer) clearTimeout(this.stopTimer)
    this.releaseMedia()
    this.recorder = null
    this.unsub?.()
    this.unsub = null
    void invoke('transcriber:liveClose', this.id).catch(() => {})
    if (!silent) this.h.onEnd()
  }
}

// -------------------------------------------------------------- formatos ---

export interface Segment {
  start: number
  end: number
  text: string
}

function srtTime(s: string): number {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s)
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
}

export function parseSrt(srt: string): Segment[] {
  const out: Segment[] = []
  for (const block of srt.split(/\r?\n\r?\n/)) {
    const lines = block.trim().split(/\r?\n/)
    const ti = lines.findIndex((l) => l.includes('-->'))
    if (ti < 0) continue
    const [a, b] = lines[ti].split('-->')
    out.push({ start: srtTime(a), end: srtTime(b), text: lines.slice(ti + 1).join(' ').trim() })
  }
  return out
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(r).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

// ------------------------------------------------------------- histórico ---

export interface HistoryItem {
  id: string
  title: string
  kind: 'arquivo' | 'youtube' | 'ao vivo'
  at: number
  language: string | null
  text: string
  srt: string
}

const HKEY = 'hc.transcriber.history.v1'
const HMAX = 20
type HListener = (items: HistoryItem[]) => void
const hListeners = new Set<HListener>()

export function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HKEY)
    const v = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(v) ? (v as HistoryItem[]) : []
  } catch {
    return []
  }
}

function saveHistory(items: HistoryItem[]): void {
  try {
    localStorage.setItem(HKEY, JSON.stringify(items))
  } catch {
    /* quota cheia / storage bloqueado: histórico só na memória */
  }
  for (const l of hListeners) l(items)
}

export function addHistory(item: Omit<HistoryItem, 'id' | 'at'>): HistoryItem {
  const full: HistoryItem = { ...item, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now() }
  saveHistory([full, ...loadHistory()].slice(0, HMAX))
  return full
}

export function removeHistory(id: string): void {
  saveHistory(loadHistory().filter((x) => x.id !== id))
}

export function clearHistory(): void {
  saveHistory([])
}

export function subscribeHistory(l: HListener): () => void {
  hListeners.add(l)
  return () => {
    hListeners.delete(l)
  }
}
