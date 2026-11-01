// Estado do transcript do ChatPane: reducer puro alimentado pelo histórico
// (session.resume / session.history) e pelos eventos de turno do gateway.
// Eventos observados contra o backend real: docs/GATEWAY.md.

import type { ApprovalRequest, GatewayEvent, InflightTurn, SessionLiveInfo, TranscriptMessage } from './gateway'

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; reasoning: string; streaming: boolean }
  | {
      kind: 'tool'
      id: string
      name: string
      context: string
      args: Record<string, unknown> | null
      status: 'running' | 'done'
      summary: string
      result: string
      duration: number | null
    }
  | { kind: 'note'; id: string; tone: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'slash'; id: string; command: string; output: string; warning: string }

/** Aprovação pendente. `rpcId` presente = veio por server request vivo (responde-se pela
 *  Promise do handler); ausente = restaurada por session.resume (responde-se via
 *  approval.respond). */
export interface PendingApproval {
  key: string
  rpcId: string | null
  sessionId: string
  request: ApprovalRequest
}

export interface ChatState {
  items: ChatItem[]
  running: boolean
  status: string
  info: SessionLiveInfo | null
  usage: Record<string, unknown> | null
}

export const initialChat: ChatState = { items: [], running: false, status: '', info: null, usage: null }

export type ChatAction =
  | { type: 'reset' }
  | { type: 'load'; messages: TranscriptMessage[]; info: SessionLiveInfo | null; running: boolean; inflight: InflightTurn | null }
  | { type: 'user'; text: string }
  | { type: 'note'; tone: 'info' | 'warn' | 'error'; text: string }
  | { type: 'slash'; command: string; output: string; warning: string }
  | { type: 'event'; event: GatewayEvent }
  | { type: 'running'; running: boolean }

let seq = 0
const nid = (p: string) => `${p}${++seq}`

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function fromHistory(messages: TranscriptMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  for (const m of messages) {
    const text = str(m.text)
    if (m.role === 'user') {
      if (text) items.push({ kind: 'user', id: nid('u'), text })
    } else if (m.role === 'assistant') {
      if (text || m.reasoning)
        items.push({ kind: 'assistant', id: nid('a'), text, reasoning: str(m.reasoning), streaming: false })
    } else if (m.role === 'tool') {
      items.push({
        kind: 'tool',
        id: nid('t'),
        name: str(m.name) || 'tool',
        context: str(m.context),
        args: m.args ?? null,
        status: 'done',
        summary: '',
        result: '',
        duration: null,
      })
    } else if (text) {
      items.push({ kind: 'note', id: nid('n'), tone: 'info', text })
    }
  }
  return items
}

/** Índice do segmento de assistente em streaming (último item), ou -1. */
function openAssistant(items: ChatItem[]): number {
  const last = items.length - 1
  const it = items[last]
  return it && it.kind === 'assistant' && it.streaming ? last : -1
}

function sealOpen(items: ChatItem[]): ChatItem[] {
  const i = openAssistant(items)
  if (i < 0) return items
  const it = items[i] as Extract<ChatItem, { kind: 'assistant' }>
  const next = items.slice()
  if (!it.text && !it.reasoning) next.splice(i, 1)
  else next[i] = { ...it, streaming: false }
  return next
}

function appendAssistant(items: ChatItem[], field: 'text' | 'reasoning', chunk: string): ChatItem[] {
  const next = items.slice()
  const i = openAssistant(next)
  if (i < 0) {
    next.push({
      kind: 'assistant',
      id: nid('a'),
      text: field === 'text' ? chunk : '',
      reasoning: field === 'reasoning' ? chunk : '',
      streaming: true,
    })
  } else {
    const it = next[i] as Extract<ChatItem, { kind: 'assistant' }>
    next[i] = { ...it, [field]: it[field] + chunk }
  }
  return next
}

function onEvent(state: ChatState, e: GatewayEvent): ChatState {
  const p = e.payload ?? {}
  switch (e.type) {
    case 'message.start':
      return { ...state, running: true, status: '' }
    case 'message.delta':
      return { ...state, running: true, items: appendAssistant(state.items, 'text', str(p.text)) }
    case 'reasoning.delta':
      return { ...state, items: appendAssistant(state.items, 'reasoning', str(p.text)) }
    case 'thinking.delta':
      // canal de spinner/status do backend (faces kawaii, avisos de espera; '' limpa) — não é raciocínio
      return { ...state, status: str(p.text) }
    case 'message.interim': {
      // texto intermediário (ao lado de tool calls) selado como segmento próprio
      if (p.already_streamed) return { ...state, items: sealOpen(state.items) }
      const items = sealOpen(state.items)
      const text = str(p.text)
      return text
        ? { ...state, items: [...items, { kind: 'assistant', id: nid('a'), text, reasoning: '', streaming: false }] }
        : state
    }
    case 'tool.generating':
      return { ...state, status: `preparando ${str(p.name)}…` }
    case 'tool.start': {
      const items = [...sealOpen(state.items)]
      items.push({
        kind: 'tool',
        id: str(p.tool_id) || nid('t'),
        name: str(p.name) || 'tool',
        context: str(p.context) || str(p.preview) || str(p.args_text),
        args: (p.args as Record<string, unknown> | null) ?? null,
        status: 'running',
        summary: '',
        result: '',
        duration: null,
      })
      return { ...state, running: true, status: '', items }
    }
    case 'tool.complete': {
      const id = str(p.tool_id)
      const items = state.items.map((it) =>
        it.kind === 'tool' && it.id === id
          ? {
              ...it,
              status: 'done' as const,
              summary: str(p.summary),
              result: str(p.result_text),
              duration: typeof p.duration_s === 'number' ? p.duration_s : null,
              args: (p.args as Record<string, unknown> | null) ?? it.args,
            }
          : it,
      )
      return { ...state, items }
    }
    case 'message.complete': {
      let items = state.items
      const finalText = str(p.text)
      const i = openAssistant(items)
      if (i >= 0) {
        const it = items[i] as Extract<ChatItem, { kind: 'assistant' }>
        items = items.slice()
        items[i] = { ...it, text: it.text || finalText, reasoning: it.reasoning || str(p.reasoning), streaming: false }
      } else if (finalText && !lastAssistantHas(items, finalText)) {
        items = [...items, { kind: 'assistant', id: nid('a'), text: finalText, reasoning: str(p.reasoning), streaming: false }]
      }
      items = sealOpen(items)
      if (p.status === 'error') {
        items = [...items, { kind: 'note', id: nid('n'), tone: 'error', text: str(p.error) || str(p.failure_reason) || 'o turno terminou com erro' }]
      } else if (p.status === 'interrupted') {
        items = [...items, { kind: 'note', id: nid('n'), tone: 'warn', text: 'turno interrompido' }]
      }
      if (p.warning) items = [...items, { kind: 'note', id: nid('n'), tone: 'warn', text: str(p.warning) }]
      return {
        ...state,
        items,
        running: false,
        status: '',
        usage: (p.usage as Record<string, unknown> | null) ?? state.usage,
      }
    }
    case 'status.update':
      return { ...state, status: str(p.text) }
    case 'session.usage':
      return { ...state, usage: (p.usage as Record<string, unknown> | null) ?? state.usage }
    case 'session.info':
      return { ...state, info: { ...(state.info ?? {}), ...(p as SessionLiveInfo) } }
    case 'error':
      return { ...state, items: [...state.items, { kind: 'note', id: nid('n'), tone: 'error', text: str(p.message) || 'erro do backend' }] }
    case 'notice':
      return { ...state, items: [...state.items, { kind: 'note', id: nid('n'), tone: 'info', text: str(p.message) }] }
    default:
      return state
  }
}

function lastAssistantHas(items: ChatItem[], text: string): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'user') return false
    if (it.kind === 'assistant' && it.text.trim() === text.trim()) return true
  }
  return false
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return initialChat
    case 'load': {
      const items = fromHistory(action.messages)
      const inf = action.inflight
      if (action.running && inf) {
        // turno em andamento ao abrir: reconstrói as bolhas do turno vivo
        if (inf.user && !(items.at(-1)?.kind === 'user')) items.push({ kind: 'user', id: nid('u'), text: inf.user })
        if (inf.assistant) items.push({ kind: 'assistant', id: nid('a'), text: inf.assistant, reasoning: '', streaming: true })
      }
      return { ...initialChat, items, running: action.running, info: action.info }
    }
    case 'user':
      return { ...state, items: [...sealOpen(state.items), { kind: 'user', id: nid('u'), text: action.text }] }
    case 'note':
      return { ...state, items: [...state.items, { kind: 'note', id: nid('n'), tone: action.tone, text: action.text }] }
    case 'slash':
      return {
        ...state,
        items: [...state.items, { kind: 'slash', id: nid('s'), command: action.command, output: action.output, warning: action.warning }],
      }
    case 'running':
      return { ...state, running: action.running, status: action.running ? state.status : '' }
    case 'event':
      return onEvent(state, action.event)
  }
}
