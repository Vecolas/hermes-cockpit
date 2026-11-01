// Wrappers tipados sobre o HermesRpc para o chat do cockpit.
//
// Nomes de métodos/params são os REAIS do contrato do tui_gateway
// (~/.hermes/hermes-agent/apps/shared/src/gateway-contract.openrpc.json) e foram
// validados contra `hermes serve` por scripts/smoke-chat.mjs. Mapeamento completo e
// eventos observados: docs/GATEWAY.md.
//
// Regra do Bot Mode (apps/desktop/src/AGENTS.md): a identidade do chat eterno de um bot
// é (profile, sessão intitulada exatamente "Bot Chat"), resolvida A CADA abertura via
// session.list {title, include_hidden:true}. NUNCA guardar session-id como identidade.

import type { HermesRpc } from './rpc'

export const BOT_CHAT_TITLE = 'Bot Chat'
const PROFILE_SESSION_LIST_LIMIT = 200

// ── tipos do wire (subconjunto do gateway-contract.generated.ts) ─────────────

export interface SessionRow {
  id: string
  resolved_id?: string | null
  root_title?: string
  title?: string
  preview?: string
  started_at?: number
  message_count?: number
  source?: string
}

export interface TranscriptMessage {
  role: string
  text?: string | null
  timestamp?: number | null
  row_id?: number | null
  display_kind?: string | null
  name?: string | null
  context?: string | null
  args?: Record<string, unknown> | null
  reasoning?: string | null
}

export interface SessionLiveInfo {
  model?: string
  provider?: string
  approval_mode?: string
  yolo?: boolean
  running?: boolean
  title?: string
  stored_session_id?: string
  [k: string]: unknown
}

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

/** Parâmetros do server request `approval` (ApprovalRequestParams) e, sem o
 *  session_id, do `pending_approval` devolvido pelo session.resume. */
export interface ApprovalRequest {
  session_id?: string
  request_id?: string | null
  command?: string | null
  description?: string | null
  choices?: string[] | null
  allow_permanent?: boolean | null
  allow_session?: boolean | null
  smart_denied?: boolean | null
  tool_name?: string | null
}

export interface OpenRequestEntry {
  id: string
  method: string
  params: Record<string, unknown>
}

export interface InflightTurn {
  assistant?: string
  streaming?: boolean
  user?: string
  error?: string | null
  status?: string | null
}

export interface ResumedSession {
  /** id RUNTIME — é ele que prompt.submit/interrupt/eventos usam */
  session_id: string
  stored_session_id?: string | null
  message_count: number
  messages: TranscriptMessage[]
  info: SessionLiveInfo
  running?: boolean | null
  inflight?: InflightTurn | null
  pending_approval?: ApprovalRequest | null
  open_requests?: OpenRequestEntry[] | null
}

export interface CreatedSession {
  session_id: string
  stored_session_id: string
  message_count: number
  messages: TranscriptMessage[]
  info: SessionLiveInfo
}

export interface CommandsCatalog {
  pairs?: string[][]
  sub?: Record<string, string[]>
  canon?: Record<string, string>
  commands?: Record<string, { argument_mode?: string | null; desktop?: string | null }>
  categories?: { name: string; pairs?: string[][] }[]
  skills?: Record<string, { usage?: number; origin?: string }>
  skill_count?: number
  warning?: string
}

export interface SlashCommand {
  /** com a barra: "/goal" */
  name: string
  description: string
  kind: 'command' | 'skill'
  usage: number
}

export type DispatchType = 'exec' | 'alias' | 'plugin' | 'send' | 'skill' | 'prefill'

export interface SlashExecResult {
  output?: string | null
  warning?: string | null
  type?: DispatchType | null
  target?: string | null
  message?: string | null
  notice?: string | null
  display?: string | null
  name?: string | null
  status?: string | null
}

export interface ModelPricing {
  input?: string
  output?: string
  cache?: string | null
  free?: boolean
  discount_percent?: number | null
}

export interface ModelOptionProvider {
  slug: string
  name: string
  models: string[]
  total_models?: number | null
  is_current?: boolean | null
  is_user_defined?: boolean | null
  source?: string | null
  api_url?: string | null
  auth_type?: string | null
  authenticated?: boolean | null
  warning?: string | null
  featured_models?: string[] | null
  capabilities?: Record<string, { fast?: boolean; reasoning?: boolean; can_disable_reasoning?: boolean | null }> | null
  pricing?: Record<string, ModelPricing> | null
  free_tier?: boolean | null
  unavailable_models?: string[] | null
  [k: string]: unknown
}

export interface ModelOptions {
  providers: ModelOptionProvider[]
  model?: string
  provider?: string
}

export interface ProfileModel {
  model: string | null
  provider: string | null
  fallback: { model: string; provider?: string }[]
  /** profiles.list reporta um `canonical_session` (Bot Chat existe) — usado para falhar
   *  fechado se a consulta por título vier vazia */
  hasCanonical: boolean
}

export interface ConfigSetResult {
  key: string
  value?: string | boolean | null
  warning?: string | null
  confirm_required?: boolean | null
  confirm_message?: string | null
  scope?: string | null
  deferred?: boolean | null
}

/** Envelope de notificação: frame `{method:"event", params:{type, session_id?, payload?, seq?}}`. */
export interface GatewayEvent {
  type: string
  session_id?: string
  payload?: Record<string, unknown>
  seq?: number
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function parseGatewayEvent(method: string, params: unknown): GatewayEvent | null {
  if (method !== 'event' || !params || typeof params !== 'object') return null
  const p = params as Record<string, unknown>
  if (typeof p.type !== 'string') return null
  return {
    type: p.type,
    session_id: typeof p.session_id === 'string' ? p.session_id : undefined,
    payload: p.payload && typeof p.payload === 'object' ? (p.payload as Record<string, unknown>) : undefined,
    seq: typeof p.seq === 'number' ? p.seq : undefined,
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isCanonicalRow(row: SessionRow): boolean {
  const root = String(row.root_title ?? '').trim()
  const title = String(row.title ?? '').trim()
  return root === BOT_CHAT_TITLE || (!root && title === BOT_CHAT_TITLE)
}

// ── sessão canônica (Bot Chat) ───────────────────────────────────────────────

/** Consulta o registro (profile, "Bot Chat"). FALHA FECHADO: erro de RPC lança — nunca
 *  é lido como "não existe" (é assim que o chat eterno se bifurca). */
export async function findBotChat(rpc: HermesRpc, profile: string): Promise<SessionRow | null> {
  let res: { sessions?: SessionRow[] }
  try {
    res = await rpc.call<{ sessions?: SessionRow[] }>('session.list', {
      profile,
      title: BOT_CHAT_TITLE,
      limit: PROFILE_SESSION_LIST_LIMIT,
      include_hidden: true,
    })
  } catch (e) {
    throw new Error(`não foi possível consultar o Bot Chat de ${profile} (${errMessage(e)}) — nenhum chat novo criado`)
  }
  return (res?.sessions ?? []).find(isCanonicalRow) ?? null
}

const creations = new Map<string, Promise<SessionRow>>()

/** Resolve o Bot Chat do profile; se não existir, cria (hidden, follow_profile_config),
 *  titula na hora (session.title materializa a linha) e adota um vencedor concorrente em
 *  conflito de título. `hadCanonical` (canonical_session do profiles.list) transforma
 *  "lista vazia" em erro em vez de criar — mesma salvaguarda do desktop oficial. */
export async function resolveBotChat(
  rpc: HermesRpc,
  profile: string,
  opts: { hadCanonical?: boolean } = {},
): Promise<SessionRow> {
  const existing = await findBotChat(rpc, profile)
  if (existing) return existing
  if (opts.hadCanonical) {
    throw new Error(`Bot Chat de ${profile} não confirmado pelo backend — tente de novo (nada foi criado)`)
  }
  const inflight = creations.get(profile)
  if (inflight) return inflight
  const run = (async (): Promise<SessionRow> => {
    const created = await rpc.call<CreatedSession>('session.create', {
      profile,
      title: BOT_CHAT_TITLE,
      hidden: true,
      follow_profile_config: true,
    })
    try {
      await rpc.call('session.title', { session_id: created.session_id, profile, title: BOT_CHAT_TITLE })
    } catch (e) {
      if (/already in use/i.test(errMessage(e))) {
        const winner = await findBotChat(rpc, profile)
        if (winner) return winner
      }
      // gateway antigo: o título fica pendente até o 1º prompt; segue com a sessão criada
    }
    return { id: created.stored_session_id, title: BOT_CHAT_TITLE, message_count: 0 }
  })().finally(() => creations.delete(profile))
  creations.set(profile, run)
  return run
}

/** Anexa a uma sessão ARMAZENADA (id do registro ou lineage tip) e devolve o id runtime +
 *  transcript + aprovação pendente / requests abertos. */
export function resumeSession(rpc: HermesRpc, storedId: string, profile: string): Promise<ResumedSession> {
  return rpc.call<ResumedSession>('session.resume', { session_id: storedId, profile })
}

/** Side-chats: sessões visíveis do profile (o Bot Chat é sempre hidden, fica fora). */
export async function listSessions(rpc: HermesRpc, profile: string, limit = 30): Promise<SessionRow[]> {
  const res = await rpc.call<{ sessions?: SessionRow[] }>('session.list', { profile, limit })
  return (res?.sessions ?? []).filter((s) => !isCanonicalRow(s))
}

/** Novo side-chat (lazy: a linha no DB nasce no 1º prompt). */
export function createSideChat(rpc: HermesRpc, profile: string): Promise<CreatedSession> {
  return rpc.call<CreatedSession>('session.create', { profile, follow_profile_config: true })
}

export async function loadHistory(rpc: HermesRpc, sessionId: string, profile?: string): Promise<TranscriptMessage[]> {
  const res = await rpc.call<{ messages?: TranscriptMessage[] }>('session.history', {
    session_id: sessionId,
    ...(profile ? { profile } : {}),
  })
  return res?.messages ?? []
}

// ── turno ────────────────────────────────────────────────────────────────────

export function submitPrompt(
  rpc: HermesRpc,
  sessionId: string,
  text: string,
): Promise<{ status?: 'streaming' | 'queued' | 'steered' | 'redirected' | null }> {
  return rpc.call('prompt.submit', { session_id: sessionId, text })
}

export function interruptTurn(rpc: HermesRpc, sessionId: string): Promise<unknown> {
  return rpc.call('session.interrupt', { session_id: sessionId })
}

/** Caminho alternativo de aprovação (aprovações restauradas por session.resume, sem um
 *  server request vivo nas mãos). O caminho principal é responder o server request
 *  `approval` com `{choice}` — ver ChatPane / setRequestHandler. */
export async function respondApproval(
  rpc: HermesRpc,
  sessionId: string,
  choice: ApprovalChoice,
  requestId?: string | null,
): Promise<number> {
  const res = await rpc.call<{ resolved?: number }>('approval.respond', {
    session_id: sessionId,
    choice,
    ...(requestId ? { request_id: requestId } : {}),
  })
  return res?.resolved ?? 0
}

// ── slash ────────────────────────────────────────────────────────────────────

export function commandsCatalog(rpc: HermesRpc, opts: { profile?: string; sessionId?: string }): Promise<CommandsCatalog> {
  return rpc.call<CommandsCatalog>('commands.catalog', {
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
  })
}

/** Achata o catálogo em uma lista para autocomplete. Skills entram mesmo sem par próprio. */
export function flattenCatalog(cat: CommandsCatalog | null): SlashCommand[] {
  if (!cat) return []
  const out = new Map<string, SlashCommand>()
  // As chaves de `skills` podem vir com ou sem "/" — normaliza para o nome nu.
  const skills: Record<string, { usage?: number } | undefined> = {}
  for (const [k, v] of Object.entries(cat.skills ?? {})) skills[k.replace(/^\/+/, '')] = v
  for (const pair of cat.pairs ?? []) {
    const [rawName, desc] = pair
    if (!rawName) continue
    const name = `/${rawName.replace(/^\/+/, "")}`
    const bare = name.slice(1)
    const skill = skills[bare]
    out.set(name, {
      name,
      description: desc ?? '',
      kind: skill ? 'skill' : 'command',
      usage: skill?.usage ?? 0,
    })
  }
  for (const [bare, meta] of Object.entries(skills)) {
    const name = `/${bare}`
    if (!out.has(name)) out.set(name, { name, description: 'skill', kind: 'skill', usage: meta?.usage ?? 0 })
  }
  return [...out.values()]
}

export function execSlash(rpc: HermesRpc, sessionId: string, command: string): Promise<SlashExecResult> {
  return rpc.call<SlashExecResult>('slash.exec', { session_id: sessionId, command: command.replace(/^\/+/, '') })
}

/** Fallback do desktop oficial quando slash.exec falha (skill/send/alias). */
export function commandDispatch(rpc: HermesRpc, sessionId: string, name: string, arg: string): Promise<SlashExecResult> {
  return rpc.call<SlashExecResult>('command.dispatch', { session_id: sessionId, name, arg })
}

// ── modelo ───────────────────────────────────────────────────────────────────

type FallbackEntry = { model: string; provider?: string }

function parseFallback(raw: unknown): FallbackEntry[] {
  const list: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  const out: FallbackEntry[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.model === 'string' && o.model) {
      out.push({ model: o.model, ...(typeof o.provider === 'string' ? { provider: o.provider } : {}) })
    }
  }
  return out
}

/** Modelo do profile (profiles.list) + cadeia de fallback (config.yaml `fallback_model`,
 *  lida via config.get {key:"full"}; só esse campo é retido). */
export async function getProfileModel(rpc: HermesRpc, profile: string): Promise<ProfileModel> {
  const [profiles, full] = await Promise.allSettled([
    rpc.call<{
      profiles?: { name: string; model?: string | null; provider?: string | null; canonical_session?: { id?: string } | null }[]
    }>('profiles.list', {}),
    rpc.call<{ config?: Record<string, unknown> | null }>('config.get', { profile, key: 'full' }),
  ])
  if (profiles.status === 'rejected') throw profiles.reason
  const row = profiles.value?.profiles?.find((p) => p.name === profile)
  const fallback = full.status === 'fulfilled' ? parseFallback(full.value?.config?.fallback_model) : []
  return {
    model: row?.model ?? null,
    provider: row?.provider ?? null,
    fallback,
    hasCanonical: Boolean(row?.canonical_session?.id),
  }
}

export function modelOptions(rpc: HermesRpc, opts: { profile: string; sessionId?: string; refresh?: boolean }): Promise<ModelOptions> {
  return rpc.call<ModelOptions>('model.options', {
    profile: opts.profile,
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
    ...(opts.refresh ? { refresh: true } : {}),
  })
}

/** Troca de modelo. O gateway exige sessão viva (sem sessão → erro 4001). `persist`
 *  grava como default do profile (`--global`); senão vale só para a sessão (`--session`). */
export function switchModel(
  rpc: HermesRpc,
  args: { sessionId: string; profile: string; model: string; provider: string; persist: boolean; confirm?: boolean },
): Promise<ConfigSetResult> {
  return rpc.call<ConfigSetResult>('config.set', {
    session_id: args.sessionId,
    profile: args.profile,
    key: 'model',
    value: `${args.model} --provider ${args.provider} ${args.persist ? '--global' : '--session'}`,
    ...(args.confirm ? { confirm_expensive_model: true } : {}),
  })
}

// ── gestão de sessões (gaveta, abas, armazenamento) ─────────────────────────
//
// Mistura RPC e REST de propósito, cada um onde o backend é dono do caso:
// - session.title exige sessão VIVA (session_scoped) → usado para a aba aberta;
//   fora disso, PATCH /api/sessions/{id} {title, profile}.
// - session.set_hidden aceita id runtime ou armazenado.
// - session.delete (RPC) recusa sessão viva (4023) — é a salvaguarda certa; o
//   DELETE REST apagaria mesmo com o agente vivo. Usamos o RPC.
// - busca e export só existem em REST.

/** Linha rica de GET /api/sessions e /api/sessions/search (subconjunto). */
export interface RestSessionRow {
  id: string
  session_id?: string
  title?: string | null
  preview?: string | null
  snippet?: string | null
  source?: string | null
  model?: string | null
  started_at?: number | null
  ended_at?: number | null
  last_active?: number | null
  message_count?: number | null
  tool_call_count?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  archived?: boolean
  pinned?: boolean
  is_active?: boolean
  profile?: string
}

export interface SessionStats {
  total: number
  active_store: number
  archived: number
  messages: number
  by_source: Record<string, number>
}

export interface ModelInfo {
  model: string
  provider: string
  auto_context_length: number
  config_context_length: number
  effective_context_length: number
  capabilities: Record<string, unknown>
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v))
  const s = u.toString()
  return s ? `?${s}` : ''
}

/** Lista de sessões com include_hidden opcional (o Bot Chat fica de fora sempre). */
export async function listSessionsAll(
  rpc: HermesRpc,
  profile: string,
  opts: { limit?: number; includeHidden?: boolean } = {},
): Promise<SessionRow[]> {
  const res = await rpc.call<{ sessions?: SessionRow[] }>('session.list', {
    profile,
    limit: opts.limit ?? 100,
    ...(opts.includeHidden ? { include_hidden: true } : {}),
  })
  return (res?.sessions ?? []).filter((s) => !isCanonicalRow(s))
}

/** Busca FTS (id + conteúdo) — REST /api/sessions/search. */
export async function searchSessions(api: ApiFn, profile: string, q: string, limit = 30): Promise<RestSessionRow[]> {
  const res = await api<{ results?: RestSessionRow[] }>(`/api/sessions/search${qs({ q, limit, profile })}`)
  return (res?.results ?? []).map((r) => ({ ...r, id: r.session_id || r.id }))
}

/** Renomeia: sessão viva → session.title (runtime); senão PATCH REST. Recusa "Bot Chat"
 *  (é a identidade do chat eterno — um side-chat com esse título bifurcaria o canônico). */
export async function renameSession(
  rpc: HermesRpc | null,
  api: ApiFn,
  args: { profile: string; storedId: string; runtimeId?: string | null; title: string },
): Promise<string> {
  const title = args.title.trim()
  if (!title) throw new Error('título vazio')
  if (title.toLowerCase() === BOT_CHAT_TITLE.toLowerCase()) throw new Error(`"${BOT_CHAT_TITLE}" é reservado ao chat canônico`)
  if (rpc && args.runtimeId) {
    const res = await rpc.call<{ title?: string }>('session.title', {
      session_id: args.runtimeId,
      profile: args.profile,
      title,
    })
    return res?.title || title
  }
  const res = await api<{ title?: string }>(`/api/sessions/${encodeURIComponent(args.storedId)}`, {
    method: 'PATCH',
    body: { title, profile: args.profile },
  })
  return res?.title || title
}

export function setSessionHidden(rpc: HermesRpc, profile: string, sessionId: string, hidden: boolean): Promise<{ hidden: boolean }> {
  return rpc.call('session.set_hidden', { session_id: sessionId, hidden, profile })
}

/** Apaga sessão ARMAZENADA via RPC (recusa sessão viva com 4023). */
export function deleteSessionRpc(rpc: HermesRpc, profile: string, storedId: string): Promise<{ deleted: string }> {
  return rpc.call('session.delete', { session_id: storedId, profile })
}

/** Fecha a sessão runtime (não apaga nada do registro). */
export function closeSession(rpc: HermesRpc, runtimeId: string, profile?: string): Promise<{ closed: boolean }> {
  return rpc.call('session.close', { session_id: runtimeId, ...(profile ? { profile } : {}) })
}

/** Export (metadados + mensagens) — REST /api/sessions/{id}/export. */
export function exportSession(api: ApiFn, profile: string, storedId: string): Promise<unknown> {
  return api(`/api/sessions/${encodeURIComponent(storedId)}/export${qs({ profile })}`)
}

/** Contexto/capacidades do modelo configurado do profile — REST /api/model/info. */
export function modelInfo(api: ApiFn, profile: string): Promise<ModelInfo> {
  return api<ModelInfo>(`/api/model/info${qs({ profile })}`)
}

/** Grava o modelo principal no config.yaml DO PROFILE (não toca o profile do serve).
 *  Vale para sessões novas — e para o Bot Chat no próximo resume (follow_profile_config). */
export function setProfileDefaultModel(api: ApiFn, profile: string, provider: string, model: string): Promise<{ ok: boolean }> {
  return api(`/api/profiles/${encodeURIComponent(profile)}/model`, { method: 'PUT', body: { provider, model } })
}

// REST de armazenamento (StoragePanel)
export function sessionStats(api: ApiFn, profile?: string): Promise<SessionStats> {
  return api<SessionStats>(`/api/sessions/stats${qs({ profile })}`)
}
export function emptySessionCount(api: ApiFn, profile?: string): Promise<{ count: number }> {
  return api(`/api/sessions/empty/count${qs({ profile })}`)
}
export function deleteEmptySessions(api: ApiFn, profile?: string): Promise<{ ok: boolean; deleted: number }> {
  return api(`/api/sessions/empty${qs({ profile })}`, { method: 'DELETE' })
}
/** GET /api/sessions (limit ≤ 100, paginado). Exclui ocultas (o Bot Chat é oculto). */
export function restSessions(
  api: ApiFn,
  profile: string,
  opts: { limit?: number; offset?: number; archived?: 'exclude' | 'only' | 'include'; order?: 'created' | 'recent' } = {},
): Promise<{ sessions: RestSessionRow[]; total: number }> {
  return api(
    `/api/sessions${qs({ profile, limit: opts.limit ?? 100, offset: opts.offset ?? 0, archived: opts.archived ?? 'include', order: opts.order ?? 'recent' })}`,
  )
}
export function bulkDeleteSessions(api: ApiFn, profile: string, ids: string[]): Promise<{ ok: boolean; deleted: number }> {
  return api('/api/sessions/bulk-delete', { method: 'POST', body: { ids, profile } })
}

/** Assinatura de lib/ipc.ts::api — injetada para manter gateway.ts testável. */
export type ApiFn = <T = unknown>(path: string, init?: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown }) => Promise<T>
