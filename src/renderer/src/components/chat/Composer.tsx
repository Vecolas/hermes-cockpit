import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SlashCommand } from '../../lib/gateway'
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
  onSend: (text: string) => Promise<boolean>
  onCancel: () => void
  /** texto injetado de fora (prefill de slash); `nonce` muda a cada injeção */
  prefill?: { text: string; nonce: number } | null
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
  onSend,
  onCancel,
  prefill,
}: Props) {
  const [text, setText] = useState('')
  const [sel, setSel] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [sending, setSending] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

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
    const value = text.trim()
    if (!value || disabled || sending) return
    if (listening) dictation.stop()
    setSending(true)
    try {
      const ok = await onSend(value)
      if (ok) setText('')
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
      <div className="relative rounded-lg border border-edge bg-panel px-3.5 pb-2 pt-2 focus-within:border-amber/50">
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
          placeholder={disabled ? (disabledReason ?? 'indisponível') : `Fala com o ${title}...`}
          className="block w-full resize-none bg-transparent leading-relaxed text-ink placeholder:text-faint focus:outline-none disabled:cursor-not-allowed"
        />
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
          <button
            disabled
            title="Anexos ainda não suportados no cockpit"
            className="cursor-not-allowed rounded border border-edge px-2 py-0.5 text-[11px] text-faint/60"
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
                disabled={disabled || sending || !text.trim()}
                className="rounded bg-amber px-2.5 py-0.5 text-[11px] font-semibold text-void hover:brightness-110 disabled:opacity-30"
              >
                enviar ⏎
              </button>
            )}
          </div>
        </div>
      </div>
      {footerLeft && <div className="mt-1.5 px-1 text-[10.5px] text-faint">{footerLeft}</div>}
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
