import { agendaPath, inSpace, spaceOfAccount, useSpace, type Space } from '../../lib/space'
import { SkeletonLines } from '../ui/Skeleton'
import { Bar, PanelFrame } from './PanelFrame'
import { usePluginSource } from './source'
import {
  API,
  calendarColor,
  fmtReset,
  fmtTokens,
  providerUsage,
  totalTokens,
  quotaWindows,
  worstWindow,
  type Agenda,
  type AgendaEvent,
  type Foco,
  type Inbox,
  type InboxItem,
  type Notion,
  type NotionTask,
  type Quota,
  type Sistema,
} from './types'

// Widgets do plugin cockpit. Cada um lê a própria fonte (polling compartilhado
// em source.tsx) e mostra erro/vazio honesto — nada de dado inventado.

export interface WidgetProps {
  refreshMs: number
}

const DAY_START = 9
const DAY_END = 18

function hourFrac(iso: string | null | undefined): number | null {
  if (!iso || !iso.includes('T')) return null // evento de dia inteiro / data sem hora
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.getHours() + d.getMinutes() / 60
}

function hhmm(iso: string | null | undefined): string {
  if (!iso || !iso.includes('T')) return '' // data sem hora (dia inteiro)
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

/** Rótulo das contas da agenda por espaço (para a linha de fonte). */
export function agendaFonte(space: Space): string {
  return space === 'houer' ? 'Google Calendar · Houer' : space === 'pessoal' ? 'Google · pessoal + FIAP' : 'Google · Houer + pessoal + FIAP'
}

/** Primeiro erro parcial de /agenda (ex.: token de uma conta expirado), mesmo com eventos das outras. */
export function agendaPartialError(a: Agenda | null): string | null {
  const e = a?.erros ? Object.entries(a.erros)[0] : null
  return e ? `${e[0]}: ${e[1]}` : null
}

interface Block {
  key: string
  color?: string
  label: string
  start: number
  end: number
  kind: 'evento' | 'livre' | 'tarefa'
  title: string
}

function clampBlock(b: Block): Block | null {
  const s = Math.max(DAY_START, b.start)
  const e = Math.min(DAY_END, b.end)
  return e > s ? { ...b, start: s, end: e } : null
}

// ─── Hoje · time-boxing ──────────────────────────────────────────────────────
export function TimeboxWidget({ refreshMs }: WidgetProps) {
  const space = useSpace()
  const agenda = usePluginSource<Agenda>(agendaPath(space, 1), refreshMs)
  const foco = usePluginSource<Foco>(API.foco, refreshMs)

  const blocks: Block[] = []
  const allDay: AgendaEvent[] = []
  const evs = (agenda.data?.events ?? []).filter((e) => inSpace(spaceOfAccount(e.conta), space))
  for (const [i, ev] of evs.entries()) {
    const s = hourFrac(ev.start)
    const e = hourFrac(ev.end)
    if (s == null || e == null) {
      allDay.push(ev)
      continue
    }
    const b = clampBlock({
      key: `ev${i}`,
      label: ev.summary ?? '(sem título)',
      start: s,
      end: e,
      kind: 'evento',
      color: calendarColor(ev.calendario),
      title: `${hhmm(ev.start)}–${hhmm(ev.end)} ${ev.summary ?? ''}${ev.calendario ? ` · ${ev.calendario}` : ''}`,
    })
    if (b) blocks.push(b)
  }
  for (const [i, t] of (foco.data?.top3_hoje ?? []).entries()) {
    const s = hourFrac(t.date)
    const e = hourFrac(t.end) ?? (s != null ? s + 1 : null)
    if (s == null || e == null) continue
    const b = clampBlock({
      key: `tk${i}`,
      label: `Foco · ${t.task ?? ''}`,
      start: s,
      end: e,
      kind: 'tarefa',
      title: `Notion: ${t.task ?? ''}`,
    })
    if (b) blocks.push(b)
  }
  for (const [i, g] of (foco.data?.blocos_livres ?? []).entries()) {
    const s = hourFrac(g.inicio)
    const e = hourFrac(g.fim)
    if (s == null || e == null) continue
    const b = clampBlock({
      key: `lv${i}`,
      label: 'livre',
      start: s,
      end: e,
      kind: 'livre',
      title: `livre ${hhmm(g.inicio)}–${hhmm(g.fim)} (${g.minutos ?? '?'} min)`,
    })
    if (b) blocks.push(b)
  }

  const now = new Date()
  const nowH = now.getHours() + now.getMinutes() / 60
  const span = DAY_END - DAY_START
  const pos = (h: number) => `${((h - DAY_START) / span) * 100}%`
  const err =
    agenda.error ?? agendaPartialError(agenda.data) ?? foco.error ?? (foco.data?.erros ? Object.values(foco.data.erros)[0] : null) ?? null
  const loading = agenda.loading && foco.loading
  const hours = Array.from({ length: span }, (_, i) => DAY_START + i)

  return (
    <PanelFrame
      titulo="Hoje · time-boxing"
      icon="clock"
      fonte={`${agendaFonte(space)} + Notion`}
      error={err}
      loading={loading}
      onRefresh={() => {
        agenda.refresh()
        foco.refresh()
      }}
    >
      <div className="relative">
        <div className="relative mb-1 h-3 text-[9px] text-faint">
          {hours.map((h) => (
            <span key={h} className="absolute -translate-x-0" style={{ left: pos(h) }}>
              {h}h
            </span>
          ))}
        </div>
        <div className="relative h-9 rounded border border-edge bg-void/40">
          {blocks.map((b) => (
            <div
              key={b.key}
              title={b.title}
              className={`absolute top-1 bottom-1 overflow-hidden rounded-sm px-1.5 text-[10px] leading-[1.6rem] whitespace-nowrap ${
                b.kind === 'livre'
                  ? 'border border-dashed border-edge2 text-faint'
                  : b.kind === 'tarefa'
                    ? 'border-l-2 border-amber bg-amber/15 text-ink'
                    : 'border-l-2 text-ink'
              }`}
              style={{
                left: pos(b.start),
                width: `calc(${((b.end - b.start) / span) * 100}% - 2px)`,
                ...(b.kind === 'evento' && b.color
                  ? { borderColor: b.color, background: `color-mix(in srgb, ${b.color} 16%, transparent)` }
                  : {}),
              }}
            >
              {b.label}
            </div>
          ))}
          {nowH >= DAY_START && nowH <= DAY_END && (
            <div className="absolute top-0 bottom-0 w-px bg-alert" style={{ left: pos(nowH) }} title="agora" />
          )}
          {!loading && blocks.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] text-faint">
              {err ? 'sem dados da agenda' : 'nenhum bloco hoje'}
            </div>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 text-[10px] text-dim">
          {foco.data?.janela && (
            <span>
              janela <span className="text-amber">{foco.data.janela}</span>
            </span>
          )}
          {foco.data?.proximo_evento?.summary && (
            <span className="truncate">
              próximo: {hhmm(foco.data.proximo_evento.start)} {foco.data.proximo_evento.summary}
            </span>
          )}
          {allDay.length > 0 && <span className="truncate">dia todo: {allDay.map((e) => e.summary).join(', ')}</span>}
        </div>
      </div>
    </PanelFrame>
  )
}

// ─── Tarefas (Notion) ────────────────────────────────────────────────────────
export function TarefasWidget({ refreshMs }: WidgetProps) {
  const notion = usePluginSource<Notion>(API.notion, refreshMs)
  const hoje = notion.data?.hoje ?? []
  const doing = notion.data?.in_progress ?? []
  const items: Array<NotionTask & { grupo: string }> = [
    ...hoje.map((t) => ({ ...t, grupo: 'hoje' })),
    ...doing.map((t) => ({ ...t, grupo: 'em curso' })),
  ]
  const counts = notion.data?.counts
  return (
    <PanelFrame
      titulo="Tarefas"
      fonte={counts?.abertas != null ? `Notion · ${counts.abertas} abertas` : 'Notion'}
      error={notion.error}
      loading={notion.loading}
      empty={!notion.loading && items.length === 0}
      emptyText={notion.error ? 'sem dados do Notion' : 'nada para hoje nem em curso'}
      onRefresh={notion.refresh}
    >
      <ul className="space-y-1">
        {items.map((t, i) => (
          <li key={t.id ?? i} className="flex items-center gap-2 text-[11px]">
            {/* somente leitura: o plugin não expõe escrita no Notion */}
            <input type="checkbox" disabled className="accent-amber" title="somente leitura" />
            <a
              href={t.url}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate text-ink hover:text-amber"
              title={t.task}
            >
              {t.task}
            </a>
            {t.prioridade?.[0] === 'HIGH' && <span className="text-[9px] text-alert">HIGH</span>}
            <span className="shrink-0 text-[9px] text-faint">{t.grupo}</span>
          </li>
        ))}
      </ul>
    </PanelFrame>
  )
}

// ─── Inbox triada ────────────────────────────────────────────────────────────
export function InboxWidget({ refreshMs }: WidgetProps) {
  const space = useSpace()
  const inbox = usePluginSource<Inbox>(API.inbox, refreshMs)
  const rows: Array<{ tag: 'responder' | 'ler'; m: InboxItem }> = [
    ...(inbox.data?.responder ?? []).map((m) => ({ tag: 'responder' as const, m })),
    ...(inbox.data?.ler ?? []).map((m) => ({ tag: 'ler' as const, m })),
  ].filter((r) => inSpace(spaceOfAccount(r.m.conta), space))
  return (
    <PanelFrame
      titulo="Inbox triada"
      icon="inbox"
      fonte={space === 'houer' ? 'Gmail Houer' : space === 'pessoal' ? 'Gmail pessoal' : 'Gmail Houer · pessoal'}
      error={inbox.error}
      loading={inbox.loading}
      empty={!inbox.loading && rows.length === 0}
      emptyText={inbox.error ? 'sem dados do Gmail' : 'inbox limpa (3 dias)'}
      onRefresh={inbox.refresh}
    >
      <ul className="space-y-1">
        {rows.map(({ tag, m }, i) => (
          <li key={i} className="flex items-center gap-2 text-[11px]" title={m.snippet}>
            <span
              className={`shrink-0 rounded border px-1.5 text-[9px] ${
                tag === 'responder' ? 'border-amber/60 text-amber' : 'border-edge2 text-faint'
              }`}
            >
              {tag}
            </span>
            <span className="min-w-0 flex-1 truncate">
              <span className="text-dim">{m.from}</span> <span className="text-ink">{m.subject}</span>
            </span>
            <span className="shrink-0 text-[9px] text-faint">{m.conta === 'work' ? 'Houer' : m.conta === 'personal' ? 'pessoal' : m.conta}</span>
          </li>
        ))}
      </ul>
    </PanelFrame>
  )
}

// ─── Agenda (lista) ──────────────────────────────────────────────────────────
export function AgendaWidget({ refreshMs }: WidgetProps) {
  const space = useSpace()
  const agenda = usePluginSource<Agenda>(agendaPath(space, 1), refreshMs)
  const evs = (agenda.data?.events ?? []).filter((e) => inSpace(spaceOfAccount(e.conta), space))
  return (
    <PanelFrame
      titulo="Agenda de hoje"
      icon="calendar"
      fonte={agendaFonte(space)}
      error={agenda.error ?? agendaPartialError(agenda.data)}
      loading={agenda.loading}
      empty={!agenda.loading && evs.length === 0}
      emptyText={agenda.error ? 'sem dados da agenda' : 'agenda livre hoje'}
      onRefresh={agenda.refresh}
    >
      <ul className="space-y-1">
        {evs.map((e, i) => (
          <li key={i} className="flex items-center gap-2 text-[11px]" title={[e.summary, e.location, e.calendario].filter(Boolean).join(' · ')}>
            <span aria-hidden className="h-2.5 w-0.5 shrink-0 rounded-full" style={{ background: calendarColor(e.calendario) }} />
            <span className="w-20 shrink-0 text-faint tabular-nums">
              {hourFrac(e.start) == null ? 'dia todo' : `${hhmm(e.start)}–${hhmm(e.end)}`}
            </span>
            {e.htmlLink ? (
              <a href={e.htmlLink} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-ink hover:text-space">
                {e.summary}
              </a>
            ) : (
              <span className="min-w-0 flex-1 truncate text-ink">{e.summary}</span>
            )}
            {e.calendario && <span className="shrink-0 text-[9px] text-faint">{e.calendario}</span>}
          </li>
        ))}
      </ul>
    </PanelFrame>
  )
}

// ─── Cota (resumo) ───────────────────────────────────────────────────────────
export function QuotaWidget({ refreshMs }: WidgetProps) {
  const quota = usePluginSource<Quota>(API.quota, refreshMs)
  const q = quota.data
  const provs = q?.provedores ?? []
  const total = totalTokens(provs)
  return (
    <PanelFrame
      titulo="Provedores · cota"
      fonte={q?.mes ? `mês ${q.mes}` : undefined}
      error={quota.error}
      loading={quota.loading}
      empty={!quota.loading && !q}
      onRefresh={quota.refresh}
    >
      {q && (
        <div className="space-y-1.5">
          {total != null && (
            <div className="text-[11px] text-dim">
              consumo <span className="text-amber">{fmtTokens(total)} tokens</span>
            </div>
          )}
          {provs.map((p, i) => (
            <ProviderRow key={i} p={p} />
          ))}
        </div>
      )}
    </PanelFrame>
  )
}

export function ProviderRow({ p }: { p: NonNullable<Quota['provedores']>[number] }) {
  const ws = quotaWindows(p)
  const worst = worstWindow(p)
  // Uso do mês: tokens por padrão; US$ só para cota explicitamente em créditos.
  const monthly = providerUsage(p).text ?? ''
  const right = worst ? `${Math.round(worst.pct)}%` : monthly || '—'
  const tone = i2tone(p.nome)
  return (
    <div role="group" aria-label={`Cota ${p.nome ?? 'provedor'}`}>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-ink" title={[p.nome, p.plano].filter(Boolean).join(' · ')}>
          {p.nome}
          {p.plano ? <span className="text-faint"> · {p.plano}</span> : null}
        </span>
        <span className="shrink-0 text-[10px] text-dim" title={worst ? `maior uso: ${worst.label}` : undefined}>
          {right}
        </span>
      </div>
      {ws.length === 0 && <Bar pct={null} tone={tone} />}
      {ws.length > 0 && (
        <ul className="mt-0.5 space-y-1">
          {ws.map((w, i) => {
            const r = fmtReset(w.reset)
            return (
              <li key={`${w.label}-${i}`} aria-label={`${w.label} ${Math.round(w.pct)}%${r ? `, reset ${r.short}` : ''}`}>
                <div className="flex items-baseline justify-between gap-2 text-[9px]">
                  <span className="truncate text-dim">{w.label}</span>
                  <span className="shrink-0 tabular-nums text-faint">
                    {r && (
                      <span title={r.full} className="mr-1.5">
                        reset {r.short}
                      </span>
                    )}
                    <span className="text-dim">{Math.round(w.pct)}%</span>
                  </span>
                </div>
                <Bar pct={w.pct} tone={tone} />
              </li>
            )
          })}
        </ul>
      )}
      {(monthly || p.aviso) && (
        <div className="mt-0.5 truncate text-[9px] text-faint" title={[monthly && `mês: ${monthly}`, p.aviso].filter(Boolean).join(' — ')}>
          {monthly && <>mês {monthly}</>}
          {monthly && p.aviso && ' · '}
          {p.aviso && <span className="text-amber/80">{p.aviso}</span>}
        </div>
      )}
      {ws.length === 0 && !monthly && !p.aviso && <div className="mt-0.5 text-[9px] text-faint">sem janela de limite</div>}
    </div>
  )
}

// Tom da barra derivado do nome do provedor (hash estável) — sem lista fixa de
// provedores: a cota é data-driven, quem aparece é o que o plugin devolver.
const TONES = ['amber', 'phos', 'cyanic'] as const
function i2tone(nome?: string): 'amber' | 'phos' | 'cyanic' {
  let h = 0
  for (const ch of nome ?? '') h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return TONES[h % TONES.length]
}

// ─── Sistema (Mac) ───────────────────────────────────────────────────────────
export function SistemaWidget({ refreshMs }: WidgetProps) {
  const sys = usePluginSource<Sistema>(API.sistema, refreshMs)
  const s = sys.data
  return (
    <PanelFrame
      titulo="Sistema · Mac"
      fonte="psutil"
      error={sys.error}
      loading={sys.loading}
      empty={!sys.loading && !s}
      onRefresh={sys.refresh}
    >
      {s && (
        <div className="space-y-1.5 text-[11px]">
          <Metric label="CPU" pct={s.cpu_percent} />
          <Metric
            label={`RAM ${s.mem_used_gb ?? '?'}/${s.mem_total_gb ?? '?'} GB`}
            pct={s.mem_percent}
          />
          <Metric label={`Disco · ${s.disk_free_gb ?? '?'} GB livres`} pct={s.disk_percent} />
          <div className="flex flex-wrap gap-x-3 text-[10px] text-dim">
            {s.load1 != null && <span>load {s.load1.toFixed(2)}</span>}
            {s.bateria_percent != null && (
              <span>
                bateria {Math.round(s.bateria_percent)}%{s.bateria_carregando ? ' ⚡' : ''}
              </span>
            )}
            <span className={s.ollama ? 'text-phos' : 'text-faint'}>ollama {s.ollama ? 'on' : 'off'}</span>
            {s.hermes_processes != null && <span>{s.hermes_processes} proc hermes</span>}
            <span className={s.gateway ? 'text-phos' : 'text-faint'}>
              gateway {s.gateway ? (s.gateway.code_version ?? 'on') : 'sem estado'}
            </span>
          </div>
        </div>
      )}
    </PanelFrame>
  )
}

function Metric({ label, pct }: { label: string; pct?: number }) {
  return (
    <div>
      <div className="flex justify-between text-[10px]">
        <span className="text-dim">{label}</span>
        <span className="text-faint">{pct != null ? `${Math.round(pct)}%` : '—'}</span>
      </div>
      <Bar pct={pct ?? null} tone="phos" />
    </div>
  )
}

// ─── Cards do dock sem fonte ainda (P2) ──────────────────────────────────────
export function DiffWidget() {
  return (
    <PanelFrame titulo="Diff pendente" fonte="git_probe · P2" empty emptyText="nenhuma fonte de diff conectada ainda (P2-13: git_probe do backend)." />
  )
}

export function SwarmWidget() {
  return (
    <PanelFrame
      titulo="Execuções do swarm"
      fonte="subagents · P2"
      empty
      emptyText="sem dados de execuções do swarm — o plugin ainda não expõe subagents (P2-15)."
    />
  )
}

/** Cota compacta para o rodapé da rail (região "rail"). */
export function RailQuotaWidget({ refreshMs }: WidgetProps) {
  const quota = usePluginSource<Quota>(API.quota, refreshMs || 60_000)
  const provs = quota.data?.provedores ?? []
  return (
    <div className="h-full overflow-y-auto px-3 py-2.5">
      <div className="label mb-1.5 flex items-center gap-2">
        <span>Provedores · cota</span>
        {quota.error && (
          <span className="truncate normal-case tracking-normal text-alert" title={quota.error}>
            erro
          </span>
        )}
      </div>
      {quota.loading && <SkeletonLines lines={4} />}
      {!quota.loading && provs.length === 0 && (
        <div className="text-[10px] text-faint">{quota.error ? 'cota indisponível' : 'sem provedores'}</div>
      )}
      <div className="space-y-2">
        {provs.map((p, i) => (
          <ProviderRow key={`${p.nome}-${i}`} p={p} />
        ))}
      </div>
    </div>
  )
}
