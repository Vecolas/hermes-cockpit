import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SlashCommand } from '../../lib/gateway'

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
            {footerRight && <span className="text-[11px] text-faint">{footerRight}</span>}
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
