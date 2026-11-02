import { useEffect, useRef } from 'react'

// Orb do voice mode em Canvas 2D. Lê os níveis (0..1) por função a cada frame —
// nada de estado React no loop. Cores vêm dos tokens @theme (CSS vars), então o
// orb acompanha tema/espaço. prefers-reduced-motion: sem rotação/ondas, só o raio
// acompanhando o nível em ~8 fps.

export type OrbPhase = 'preparando' | 'ouvindo' | 'pronto' | 'gravando' | 'transcrevendo' | 'pensando' | 'falando' | 'agindo' | 'erro'

const PHASE_VAR: Record<OrbPhase, string> = {
  preparando: '--color-faint',
  ouvindo: '--color-phos',
  pronto: '--color-dim',
  gravando: '--color-amber',
  transcrevendo: '--color-amber',
  pensando: '--color-cyanic',
  falando: '--color-amber',
  agindo: '--color-cyanic',
  erro: '--color-alert',
}

function cssColor(v: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const c = getComputedStyle(document.documentElement).getPropertyValue(v).trim()
  return c || fallback
}

function withAlpha(color: string, a: number): string {
  return `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`
}

export function VoiceOrb(props: {
  phase: OrbPhase
  micLevel: () => number
  botLevel: () => number
  size?: number
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const phaseRef = useRef(props.phase)
  phaseRef.current = props.phase
  const lv = useRef({ mic: props.micLevel, bot: props.botLevel })
  lv.current = { mic: props.micLevel, bot: props.botLevel }
  const size = props.size ?? 360

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const g = cv.getContext('2d')
    if (!g) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    cv.width = size * dpr
    cv.height = size * dpr
    g.scale(dpr, dpr)
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const colors = new Map<string, string>()
    const col = (v: string) => {
      let c = colors.get(v)
      if (!c) {
        c = cssColor(v, '#e8a33d')
        colors.set(v, c)
      }
      return c
    }
    // canvas não entende color-mix: converte cor hex em rgba
    const rgba = (hex: string, a: number) => {
      const m = hex.match(/^#?([0-9a-f]{6})$/i)
      if (!m) return withAlpha(hex, a)
      const n = parseInt(m[1], 16)
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
    }

    let raf = 0
    let last = 0
    let mic = 0
    let bot = 0
    let t0 = performance.now()
    const cx = size / 2
    const cy = size / 2
    const R = size * 0.2

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      if (reduce && now - last < 120) return
      last = now
      const t = (now - t0) / 1000
      const phase = phaseRef.current
      const base = col(PHASE_VAR[phase])
      const amber = col('--color-amber')
      const phos = col('--color-phos')
      const cyan = col('--color-cyanic')
      // suavização dos níveis
      mic += ((lv.current.mic() || 0) - mic) * 0.35
      bot += ((lv.current.bot() || 0) - bot) * 0.35
      const energy = Math.max(phase === 'falando' ? bot : 0, phase === 'gravando' || phase === 'ouvindo' ? mic : mic * 0.5, phase === 'falando' ? 0 : bot * 0.4)

      g.clearRect(0, 0, size, size)

      // halo
      const haloR = R * (1.9 + energy * 0.9)
      const halo = g.createRadialGradient(cx, cy, R * 0.4, cx, cy, haloR)
      halo.addColorStop(0, rgba(base, 0.28 + energy * 0.25))
      halo.addColorStop(0.55, rgba(base, 0.08))
      halo.addColorStop(1, rgba(base, 0))
      g.fillStyle = halo
      g.beginPath()
      g.arc(cx, cy, haloR, 0, Math.PI * 2)
      g.fill()

      // anéis de onda (fala do bot = âmbar, mic = fósforo)
      if (!reduce) {
        const rings = phase === 'falando' ? 3 : phase === 'gravando' || phase === 'ouvindo' ? 2 : 1
        for (let i = 0; i < rings; i++) {
          const k = ((t * (0.35 + energy * 0.6) + i / rings) % 1 + 1) % 1
          const rr = R * (1.05 + k * (0.9 + energy))
          g.strokeStyle = rgba(phase === 'falando' ? amber : phase === 'agindo' || phase === 'pensando' ? cyan : phos, (1 - k) * (0.18 + energy * 0.5))
          g.lineWidth = 1.2
          g.beginPath()
          g.arc(cx, cy, rr, 0, Math.PI * 2)
          g.stroke()
        }
      }

      // corpo deformado por ondas (harmônicos)
      const pts = 120
      const amp = R * (0.04 + energy * 0.42)
      g.beginPath()
      for (let i = 0; i <= pts; i++) {
        const a = (i / pts) * Math.PI * 2
        const wob = reduce
          ? 0
          : Math.sin(a * 3 + t * 1.6) * 0.5 + Math.sin(a * 5 - t * 2.3) * 0.3 + Math.sin(a * 7 + t * 3.1) * 0.2
        const r = R * (1 + (reduce ? energy * 0.25 : 0)) + wob * amp
        const x = cx + Math.cos(a) * r
        const y = cy + Math.sin(a) * r
        if (i === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      g.closePath()
      const body = g.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R * 1.25)
      body.addColorStop(0, rgba(base, 0.95))
      body.addColorStop(0.5, rgba(base, 0.45))
      body.addColorStop(1, rgba(base, 0.12))
      g.fillStyle = body
      g.fill()
      g.strokeStyle = rgba(base, 0.7)
      g.lineWidth = 1
      g.stroke()

      // pensando/agindo: arco orbitando; preparando/transcrevendo: arco curto
      if (phase === 'pensando' || phase === 'agindo' || phase === 'preparando' || phase === 'transcrevendo') {
        const rot = reduce ? 0 : t * (phase === 'agindo' ? 2.4 : 1.4)
        const len = phase === 'agindo' ? 1.6 : 0.9
        g.strokeStyle = rgba(phase === 'transcrevendo' ? amber : cyan, 0.85)
        g.lineWidth = 2
        g.lineCap = 'round'
        g.beginPath()
        g.arc(cx, cy, R * 1.45, rot, rot + len)
        g.stroke()
        if (phase === 'agindo') {
          g.beginPath()
          g.arc(cx, cy, R * 1.6, -rot * 0.7, -rot * 0.7 + 0.6)
          g.stroke()
        }
      }

      // núcleo brilhante
      g.fillStyle = rgba('#ffffff', 0.08 + energy * 0.25)
      g.beginPath()
      g.arc(cx - R * 0.25, cy - R * 0.3, R * 0.22, 0, Math.PI * 2)
      g.fill()

      // barras de nível do mic (base)
      const bars = 24
      const bw = (R * 2.4) / bars
      for (let i = 0; i < bars; i++) {
        const k = Math.abs(i - bars / 2) / (bars / 2)
        const h = 2 + mic * 26 * (1 - k * 0.8) * (reduce ? 1 : 0.7 + 0.3 * Math.sin(t * 9 + i))
        g.fillStyle = rgba(phos, 0.25 + mic * 0.6)
        g.fillRect(cx - R * 1.2 + i * bw + 1, cy + R * 2.15 - h / 2, bw - 2, h)
      }
    }
    t0 = performance.now()
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return <canvas ref={ref} style={{ width: size, height: size }} className="pointer-events-none select-none" aria-hidden />
}
