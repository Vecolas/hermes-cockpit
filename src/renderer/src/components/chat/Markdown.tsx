import { Fragment, type ReactNode } from 'react'

// Markdown mínimo para respostas do assistente — sem dependência e sem
// dangerouslySetInnerHTML (tudo vira nó React, então nada é interpretado como HTML).
// Cobre o que o Hermes emite na prática: títulos, listas, blocos de código,
// citações, **negrito**, *itálico*, `código` e [links](url). Texto parcial em
// streaming degrada bem: marcador sem par fecha como texto literal.

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))/g

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(text.slice(last, idx))
    const k = `${key}-${i++}`
    const tok = m[0]
    if (m[1]) {
      out.push(
        <code key={k} className="rounded bg-panel2 px-1 py-px text-[0.92em] text-amber/90">
          {tok.slice(1, -1)}
        </code>,
      )
    } else if (m[2]) {
      out.push(
        <strong key={k} className="font-semibold text-ink">
          {tok.slice(2, -2)}
        </strong>,
      )
    } else if (m[3]) {
      out.push(<em key={k}>{tok.slice(1, -1)}</em>)
    } else if (m[4]) {
      const label = tok.slice(1, tok.indexOf(']('))
      out.push(
        <a key={k} href={m[5]} target="_blank" rel="noreferrer" className="text-cyanic underline-offset-2 hover:underline">
          {label}
        </a>,
      )
    }
    last = idx + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let n = 0

  const flushPara = () => {
    if (!para.length) return
    const k = `p${n++}`
    blocks.push(
      <p key={k} className="my-1.5">
        {para.map((l, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(l, `${k}-${j}`)}
          </Fragment>
        ))}
      </p>,
    )
    para = []
  }
  const flushList = () => {
    if (!list) return
    const k = `l${n++}`
    const Tag = list.ordered ? 'ol' : 'ul'
    blocks.push(
      <Tag key={k} className={`my-1.5 pl-5 ${list.ordered ? 'list-decimal' : 'list-disc'} marker:text-faint`}>
        {list.items.map((it, j) => (
          <li key={j} className="my-0.5">
            {inline(it, `${k}-${j}`)}
          </li>
        ))}
      </Tag>,
    )
    list = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^```\s*(\S*)/)
    if (fence) {
      flushPara()
      flushList()
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++])
      blocks.push(
        <pre key={`c${n++}`} className="my-2 overflow-x-auto rounded border border-edge bg-void px-3 py-2 text-[12px] text-ink/90">
          {body.join('\n')}
        </pre>,
      )
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      flushPara()
      flushList()
      blocks.push(
        <div key={`h${n++}`} className="mb-1 mt-3 font-semibold text-ink">
          {inline(h[2], `h${n}`)}
        </div>,
      )
      continue
    }
    const li = line.match(/^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/)
    if (li) {
      flushPara()
      const ordered = Boolean(li[2])
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      list.items.push(li[3])
      continue
    }
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      flushPara()
      flushList()
      blocks.push(
        <blockquote key={`q${n++}`} className="my-1.5 border-l-2 border-edge2 pl-3 text-dim">
          {inline(quote[1], `q${n}`)}
        </blockquote>,
      )
      continue
    }
    if (!line.trim()) {
      flushPara()
      flushList()
      continue
    }
    flushList()
    para.push(line)
  }
  flushPara()
  flushList()
  return <>{blocks}</>
}
