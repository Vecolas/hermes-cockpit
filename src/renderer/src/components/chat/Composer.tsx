import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import type { SlashCommand } from '../../lib/gateway'
import type { HermesRpc } from '../../lib/rpc'
import { attachErrorText, detachImage, formatSize, kindOf, stageFile, type Attachment } from '../../lib/attachments'
import { toast } from '../../lib/toast'
import { useDictation } from '../transcriber/useDictation'

interface Props {
  title: string
  disabled: boolean
  disabledReason?: string
  running: boolean
  commands: SlashCommand[]
  /** atalhos frequentes (skills mais usadas do catálogo) */
  quick: SlashCommand[]
  footerLeft?: string
  footerRight?: string
  /** controles extras no rodapé (ex.: chip de modo de aprovação) */
  footerExtra?: React.ReactNode
  onSend: (text: string) => Promise<boolean>
  onCancel: () => void
  /** texto injetado de fora (prefill de slash); `nonce` muda a cada injeção */
  prefill?: { text: string; nonce: number } | null
  /** gateway + runtime session_id para stagear anexos; sem eles o botão fica desabilitado */
  rpc?: HermesRpc | null
  sessionId?: string | null
}

const MAX_SUGGESTIONS = 8

export function Composer({
  title,
  disabled,
  disabledReason,
  running,
  commands,
  quick,
  footerLeft,
  footerRight,
  footerExtra,
  onSend,
  onCancel,
  prefill,
  rpc,
  sessionId,
}: Props) {
  const [text, setText] = useState('')
  const [sel, setSel] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [sending, setSending] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  // ── anexos ────────────────────────────────────────────────────────────────
  const [atts, setAtts] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const attsRef = useRef(atts)
  attsRef.current = atts
  const attachSid = useRef(sessionId)
  const canAttach = Boolean(rpc && sessionId) && !disabled

  const addFiles = useCallback(
    (files: File[]) => {
      if (!rpc || !sessionId || files.length === 0) return
      const sid = sessionId
      for (const file of files) {
        const kind = kindOf(file)
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const name = file.name || (kind === 'image' ? 'imagem-colada.png' : 'arquivo')
        setAtts((a) => [...a, { id, name, kind, size: file.size, status: 'staging' }])
        stageFile(rpc, sid, file, kind).then(
          (staged) => {
            if (attachSid.current !== sid) {
              if (staged.stagedPath) detachImage(rpc, sid, staged.stagedPath)
              return
            }
            setAtts((a) => a.map((x) => (x.id === id ? { ...x, ...staged, status: 'ready' } : x)))
          },
          (e) => {
            const error = attachErrorText(e)
            setAtts((a) => a.map((x) => (x.id === id ? { ...x, status: 'error', error } : x)))
            toast({ title: `Falha ao anexar ${name}`, detail: error, tone: 'error' })
          },
        )
      }
    },
    [rpc, sessionId],
  )

  const removeAtt = (a: Attachment) => {
    setAtts((list) => list.filter((x) => x.id !== a.id))
    if (rpc && sessionId && a.stagedPath) detachImage(rpc, sessionId, a.stagedPath)
  }

  // troca de sessão: o que estava staged pertencia à anterior — solta e limpa
  useEffect(() => {
    const prev = attachSid.current
    attachSid.current = sessionId
    if (prev && prev !== sessionId) {
      if (rpc) for (const a of attsRef.current) if (a.stagedPath) detachImage(rpc, prev, a.stagedPath)
      setAtts([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const onDragOver = (e: DragEvent) => {
    if (!canAttach || !Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }
  const onDrop = (e: DragEvent) => {
    setDragging(false)
    if (!canAttach || e.dataTransfer.files.length === 0) return
    e.preventDefault()
    addFiles(Array.from(e.dataTransfer.files))
  }
  const onPaste = (e: ClipboardEvent) => {
    if (!canAttach) return
    const files = Array.from(e.clipboardData.files)
    if (files.length === 0) return
    e.preventDefault()
    addFiles(files)
  }

  const staging = atts.some((a) => a.status === 'staging')
  const ready = atts.filter((a) => a.status === 'ready')
  const hasContent = Boolean(text.trim()) || ready.length > 0

  // ── ditado (contrato fixo de useDictation; oculto se available=false) ─────
  const dictation = useDictation()
  const [partial, setPartial] = useState('')
  const listening = dictation.state === 'listening' || dictation.state === 'starting'
  const stopRef = useRef(dictation.stop)
  stopRef.current = dictation.stop
  const toggleDictation = () => {
    if (listening) {
      dictation.stop()
      setPartial('')
      return
    }
    setPartial('')
    dictation.start((chunk, final) => {
      if (!final) {
        setPartial(chunk)
        return
      }
      setPartial('')
      const add = chunk.trim()
      if (add) setText((t) => (t && !/\s$/.test(t) ? `${t} ${add}` : `${t}${add}`))
    })
    ta.current?.focus()
  }
  // painel desabilitado (troca de sessão/desconexão) encerra o ditado
  useEffect(() => {
    if (disabled && listening) {
      stopRef.current()
      setPartial('')
    }
  }, [disabled, listening])
  useEffect(() => {
    if (!listening) setPartial('')
  }, [listening])

  useEffect(() => {
    if (!prefill) return
    setText(prefill.text)
    ta.current?.focus()
  }, [prefill])

  // autosize
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  // autocomplete de slash: só enquanto o texto é "/palavra" sem espaço
  const slashQuery = /^\/[^\s]*$/.test(text) ? text.toLowerCase() : null
  const suggestions = useMemo(() => {
    if (slashQuery === null) return []
    return commands
      .filter((c) => c.name.toLowerCase().startsWith(slashQuery))
      .sort((a, b) => b.usage - a.usage || a.name.localeCompare(b.name))
      .slice(0, MAX_SUGGESTIONS)
  }, [commands, slashQuery])
  const showSuggest = !dismissed && suggestions.length > 0 && !(suggestions.length === 1 && suggestions[0].name === text)

  useEffect(() => {
    setSel(0)
    setDismissed(false)
  }, [slashQuery])

  const accept = (c: SlashCommand) => {
    setText(`${c.name} `)
    ta.current?.focus()
  }

  const send = async () => {
    const typed = text.trim()
    if (!hasContent || disabled || sending || staging) return
    if (listening) dictation.stop()
    const refs = ready.map((a) => a.refText).filter(Boolean) as string[]
    const images = ready.filter((a) => a.kind === 'image')
    // sem texto: convenção do backend para imagens; arquivos vão só pela referência @file:
    const base = typed || (refs.length === 0 && images.length > 0 ? `[User attached image: ${images.map((a) => a.name).join(', ')}]` : '')
    const value = [base, ...refs].filter(Boolean).join('\n')
    setSending(true)
    try {
      const ok = await onSend(value)
      if (ok) {
        setText('')
        setAtts((list) => list.filter((a) => a.status === 'staging' || a.status === 'error').filter((a) => !ready.includes(a)))
      }
    } finally {
      setSending(false)
      ta.current?.focus()
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (showSuggest) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => (s + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => (s - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        accept(suggestions[sel] ?? suggestions[0])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(true)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape' && running) {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="border-t border-edge px-5 py-3">
      <div
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`relative mx-auto max-w-[880px] rounded-xl border border-edge bg-panel px-3.5 pb-2 pt-2 shadow-[var(--hc-shadow-1)] transition-[border-color,box-shadow] duration-150 focus-within:border-amber/50 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-amber)_10%,transparent)] ${dragging ? 'border-amber/70 bg-amber/5' : ''}`}
      >
        {showSuggest && (
          <ul className="absolute bottom-full left-0 right-0 mb-1 max-h-72 overflow-y-auto rounded-md border border-edge2 bg-panel2 py-1 shadow-xl">
            {suggestions.map((c, i) => (
              <li key={c.name}>
                <button
                  onMouseDown={(e) => {
                    e.preventDefault()
                    accept(c)
                  }}
                  onMouseEnter={() => setSel(i)}
                  className={`flex w-full items-baseline gap-3 px-3 py-1 text-left ${i === sel ? 'bg-edge' : ''}`}
                >
                  <span className={c.kind === 'skill' ? 'text-phos' : 'text-cyanic'}>{c.name}</span>
                  <span className="truncate text-[11px] text-faint">{c.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="label mb-1 normal-case tracking-[0.06em]">
          Mensagem · @bot para delegar · /skill para rotina
        </div>
        <textarea
          ref={ta}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={disabled ? (disabledReason ?? 'indisponível') : `Fala com o ${title}...`}
          className="block w-full resize-none bg-transparent leading-relaxed text-ink placeholder:text-faint focus:outline-none disabled:cursor-not-allowed"
        />
        {atts.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="anexos">
            {atts.map((a) => (
              <li
                key={a.id}
                title={a.error ?? a.name}
                className={`hc-fade-in flex max-w-[260px] items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] ${
                  a.status === 'error' ? 'border-alert/50 text-alert' : 'border-edge2 bg-panel2 text-dim'
                }`}
              >
                <span className="font-mono text-[9px] uppercase tracking-wide text-faint">{a.kind === 'image' ? 'img' : a.kind}</span>
                <span className="truncate text-ink">{a.name}</span>
                <span className="shrink-0 text-faint">
                  {a.status === 'staging' ? 'enviando…' : a.status === 'error' ? 'falhou' : formatSize(a.size)}
                </span>
                <button
                  type="button"
                  onClick={() => removeAtt(a)}
                  aria-label={`remover ${a.name}`}
                  className="shrink-0 text-faint hover:text-alert"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {listening && (
          <div className="hc-fade-in mt-0.5 flex min-h-[1.4em] items-baseline gap-2 text-dim">
            <span className="hc-pulse-dot inline-block h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full bg-alert" />
            {partial ? (
              <span className="italic text-dim">{partial}</span>
            ) : (
              <span className="italic text-faint">{dictation.state === 'starting' ? 'abrindo o microfone…' : 'ouvindo…'}</span>
            )}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
          <button
            type="button"
            disabled={!canAttach}
            onClick={() => fileInput.current?.click()}
            title={canAttach ? 'Anexar arquivo, imagem ou PDF (ou arraste / cole)' : 'Anexos indisponíveis sem sessão ativa'}
            className="rounded border border-edge px-2 py-0.5 text-[11px] text-dim hover:border-amber/50 hover:text-ink disabled:cursor-not-allowed disabled:text-faint/60 disabled:hover:border-edge"
          >
            + arquivo
          </button>
          {quick.map((c) => (
            <button
              key={c.name}
              disabled={disabled}
              onClick={() => {
                setText(`${c.name} `)
                ta.current?.focus()
              }}
              title={c.description}
              className="rounded border border-edge px-2 py-0.5 text-[11px] text-dim hover:border-amber/50 hover:text-ink disabled:opacity-50"
            >
              {c.name}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            {footerExtra}
            {footerRight && <span className="truncate text-[11px] text-faint">{footerRight}</span>}
            {dictation.available && (
              <button
                onClick={toggleDictation}
                disabled={disabled && !listening}
                title={
                  dictation.state === 'error'
                    ? `ditado com erro: ${dictation.error ?? 'desconhecido'} — clique para tentar de novo`
                    : listening
                      ? 'parar ditado'
                      : 'ditar (transcriber)'
                }
                aria-pressed={listening}
                className={`relative flex h-[22px] w-[26px] items-center justify-center rounded border text-[12px] transition-colors disabled:opacity-40 ${
                  listening
                    ? 'border-alert/70 bg-alert/15 text-alert'
                    : dictation.state === 'error'
                      ? 'border-alert/40 text-alert/80 hover:border-alert'
                      : 'border-edge text-dim hover:border-amber/50 hover:text-ink'
                }`}
              >
                {listening && <span className="hc-pulse-dot absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-alert" />}
                <MicGlyph />
              </button>
            )}
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('hc:voice', { detail: { open: true } }))}
              title="modo voz — conversa falada com o bot (⌘⇧V)"
              className="flex h-[22px] w-[26px] items-center justify-center rounded border border-edge text-dim transition-colors hover:border-cyanic/60 hover:text-cyanic"
            >
              <WaveGlyph />
            </button>
            {running ? (
              <button
                onClick={onCancel}
                title="Cancelar turno (Esc)"
                className="rounded border border-alert/50 px-2.5 py-0.5 text-[11px] text-alert hover:bg-alert/10"
              >
                ■ cancelar
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={disabled || sending || staging || !hasContent}
                className="rounded bg-amber px-2.5 py-0.5 text-[11px] font-semibold text-void hover:brightness-110 disabled:opacity-30"
              >
                enviar ⏎
              </button>
            )}
          </div>
        </div>
      </div>
      {footerLeft && <div className="mx-auto mt-1.5 max-w-[880px] px-1 font-mono text-[10px] tracking-wide text-faint">{footerLeft}</div>}
    </div>
  )
}

function MicGlyph() {
  return (
    <svg width="11" height="13" viewBox="0 0 11 13" fill="none" aria-hidden>
      <rect x="3" y="0.75" width="5" height="7.5" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1 6.25a4.5 4.5 0 0 0 9 0M5.5 10.75v1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function WaveGlyph() {
  return (
    <svg width="13" height="11" viewBox="0 0 13 11" fill="none" aria-hidden>
      <path d="M1 4.5v2M3.75 2.5v6M6.5 0.75v9.5M9.25 2.5v6M12 4.5v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
