import { useEffect, type ReactNode } from 'react'
import { fmtBytes, fmtUptime, ops, type GpuInfo, type SystemInfo, type VolumeInfo } from '../../lib/ops'
import { HOST_LABEL } from '../../lib/platform'
import { ErrorState, Meter, SectionHeader, SkeletonRows, Tag, useAsync, usageTone } from './ui'

// Seção "Sistema" da Central Ops: CPU (modelo, núcleos, uso total e por
// núcleo), RAM, volumes e GPU — tudo de ops:system (src/main/metrics.ts), que
// é multiplataforma. Fonte parcial (ex.: uso de GPU indisponível no macOS)
// aparece como chip honesto, nunca como erro.

const REFRESH_MS = 4000

export function SystemSection({ onCount }: { onCount?: (n: number) => void }) {
  const s = useAsync<SystemInfo>(ops.system, [], REFRESH_MS)
  const d = s.data
  useEffect(() => {
    if (d) onCount?.(d.cpu.cores)
  }, [d, onCount])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        title="Sistema"
        subtitle={
          d ? (
            <span title={[d.hostname, d.osVersion, d.osDetail].filter(Boolean).join(' · ')}>
              {d.hostname} · {d.osVersion}
              {d.osDetail ? ` · ${d.osDetail}` : ''} · no ar há {fmtUptime(d.uptimeSec)}
            </span>
          ) : (
            'CPU, memória, volumes e GPU'
          )
        }
        loading={s.loading}
        onRefresh={() => void s.reload()}
        at={s.at}
      >
        {d?.load && (
          <Tag tone="neutral" title="load average de 1, 5 e 15 minutos">
            load {d.load.map((x) => x.toFixed(2)).join(' ')}
          </Tag>
        )}
      </SectionHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {s.error && !d ? (
          <ErrorState error={s.error} onRetry={() => void s.reload()} />
        ) : !d ? (
          <SkeletonRows rows={6} cols={2} />
        ) : (
          <div className="hc-fade-in space-y-3">
            <CpuCard info={d} />
            <MemCard info={d} />
            <VolumesCard info={d} />
            <GpuCard info={d} />
          </div>
        )}
      </div>
    </div>
  )
}

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-md border border-edge bg-panel/60 p-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="label !text-[10px] !text-dim">{title}</h3>
        <div className="ml-auto flex items-center gap-1.5">{right}</div>
      </div>
      {children}
    </section>
  )
}

/** Linha "rótulo · valor" com barra de uso. */
function Bar({ label, value, pct, title }: { label: ReactNode; value: ReactNode; pct: number; title?: string }) {
  return (
    <div title={title}>
      <div className="mb-1 flex items-baseline gap-2 text-[11.5px]">
        <span className="min-w-0 truncate text-dim">{label}</span>
        <span className="ml-auto shrink-0 tabular-nums text-faint">{value}</span>
        <span className={`w-11 shrink-0 text-right tabular-nums ${pct >= 90 ? 'text-alert' : pct >= 80 ? 'text-warn' : 'text-dim'}`}>
          {pct.toFixed(0)}%
        </span>
      </div>
      <Meter pct={pct} tone={usageTone(pct)} />
    </div>
  )
}

function CpuCard({ info }: { info: SystemInfo }) {
  const c = info.cpu
  return (
    <Card
      title="CPU"
      right={
        <>
          <Tag tone="neutral">{c.cores} núcleos</Tag>
          {c.speedMhz ? <Tag tone="neutral">{(c.speedMhz / 1000).toFixed(2)} GHz</Tag> : null}
        </>
      }
    >
      <div className="mb-2 truncate text-[11.5px] text-ink" title={c.model}>
        {c.model}
      </div>
      <Bar
        label="uso total"
        value={c.sampleMs ? `amostra de ${(c.sampleMs / 1000).toFixed(1)}s` : ''}
        pct={c.pct}
        title="diferença entre duas leituras de os.cpus()"
      />
      {c.perCore.length > 1 && (
        <div className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-x-3 gap-y-1.5">
          {c.perCore.map((p, i) => (
            <div key={i} title={`núcleo ${i} · ${p.toFixed(1)}%`}>
              <div className="flex items-baseline gap-1 text-[10px]">
                <span className="text-faint">#{i}</span>
                <span className={`ml-auto tabular-nums ${p >= 90 ? 'text-alert' : p >= 80 ? 'text-warn' : 'text-faint'}`}>{p.toFixed(0)}%</span>
              </div>
              <Meter pct={p} tone={usageTone(p)} className="!h-1" />
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

const MEM_SOURCE: Record<string, string> = {
  vm_stat: 'vm_stat (ativa + wired + comprimida, como o Monitor de Atividade)',
  '/proc/meminfo': '/proc/meminfo MemAvailable',
  'os.freemem': 'os.totalmem − os.freemem',
}

function MemCard({ info }: { info: SystemInfo }) {
  const m = info.mem
  return (
    <Card title="Memória" right={<Tag tone="neutral" title={MEM_SOURCE[m.source] ?? m.source}>{m.source}</Tag>}>
      <Bar label={`${fmtBytes(m.used)} em uso`} value={`${fmtBytes(m.free)} livres de ${fmtBytes(m.total)}`} pct={m.pct} />
    </Card>
  )
}

function volLabel(v: VolumeInfo, primary?: string): string {
  const name = v.label ? `${v.id} ${v.label}` : v.id
  return v.id === primary ? `${name} · sistema` : name
}

function VolumesCard({ info }: { info: SystemInfo }) {
  const vols = info.volumes
  return (
    <Card
      title="Armazenamento"
      right={<Tag tone="neutral">{vols.length === 1 ? '1 volume' : `${vols.length} volumes`}</Tag>}
    >
      {info.volumesError && <div className="mb-2 text-[10.5px] text-faint">lista parcial: {info.volumesError}</div>}
      {vols.length === 0 ? (
        <div className="text-[11.5px] text-faint">nenhum volume local encontrado</div>
      ) : (
        <div className="space-y-2.5">
          {vols.map((v) => (
            <Bar
              key={v.id}
              label={volLabel(v, info.primaryVolume)}
              value={`${fmtBytes(v.used)} / ${fmtBytes(v.total)} · ${fmtBytes(v.free)} livres`}
              pct={v.pct}
              title={[v.id, v.label, v.fs].filter(Boolean).join(' · ')}
            />
          ))}
        </div>
      )}
    </Card>
  )
}

function GpuCard({ info }: { info: SystemInfo }) {
  const gpus = info.gpus
  return (
    <Card title="GPU" right={gpus[0] ? <Tag tone="neutral">{gpus[0].source}</Tag> : null}>
      {gpus.length === 0 ? (
        <div className="text-[11.5px] text-faint">{info.gpuError ?? `nenhum adaptador detectado neste ${HOST_LABEL}`}</div>
      ) : (
        <div className="space-y-3">
          {gpus.map((g, i) => (
            <GpuRow key={`${g.name}-${i}`} gpu={g} />
          ))}
          {info.gpu3dPct != null && (
            <Bar
              label="3D · todos os adaptadores"
              value="soma dos engines"
              pct={info.gpu3dPct}
              title="Win32_VideoController não expõe LUID: com mais de um adaptador o uso não é atribuível a um deles"
            />
          )}
          {info.gpuError && <div className="text-[10.5px] text-faint">{info.gpuError}</div>}
        </div>
      )}
    </Card>
  )
}

function GpuRow({ gpu }: { gpu: GpuInfo }) {
  const vramPct = gpu.vramTotal && gpu.vramUsed != null ? (gpu.vramUsed / gpu.vramTotal) * 100 : null
  return (
    <div>
      <div className="mb-1.5 truncate text-[11.5px] text-ink" title={`${gpu.name} · ${gpu.source}`}>
        {gpu.name}
      </div>
      {gpu.pct == null ? (
        <div className="text-[10.5px] text-faint">uso indisponível</div>
      ) : (
        <Bar label="uso" value="" pct={gpu.pct} />
      )}
      {vramPct != null ? (
        <div className="mt-2">
          <Bar label="vram" value={`${fmtBytes(gpu.vramUsed)} / ${fmtBytes(gpu.vramTotal)}`} pct={vramPct} />
        </div>
      ) : gpu.vramTotal ? (
        <div className="mt-1 text-[10.5px] text-faint">vram {fmtBytes(gpu.vramTotal)} (uso não informado)</div>
      ) : null}
    </div>
  )
}
