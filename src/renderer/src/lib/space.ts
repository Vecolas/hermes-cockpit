import { useSyncExternalStore } from 'react'
import { BOT_GROUPS } from './bots'

// Espaço ativo do cockpit: Pessoal × Trabalho (Houer) × Tudo. CONTRATO (fixo)
// para todos os módulos: filtre o que mostra com `inSpace(spaceOf…(x), space)`.
// - bots: coordenação (chief, mercurio) e operações (argos) são compartilhados;
//   trabalho (atlas, hefesto, kairos) = houer; pessoal (lar, vesta) = pessoal.
// - paths: ~/Documents/Houer/** = houer; ~/Documents/Alexandre/** = pessoal;
//   ~/dev/** e demais = compartilhado.
// - agenda/inbox: campo `conta` do plugin ('houer' | 'pessoal'; inbox: work/personal).
// O <html> recebe data-space="<espaço>" — o tema pode variar accent por espaço.

export type Space = 'tudo' | 'houer' | 'pessoal'
/** espaço de um item; 'shared' aparece em qualquer espaço */
export type ItemSpace = 'houer' | 'pessoal' | 'shared'

export const SPACES: { id: Space; label: string; hint: string }[] = [
  { id: 'tudo', label: 'Tudo', hint: 'pessoal e Houer juntos' },
  { id: 'houer', label: 'Houer', hint: 'trabalho — bots, agenda, inbox, Notion e repos da Houer' },
  { id: 'pessoal', label: 'Pessoal', hint: 'vida pessoal, FIAP, projetos próprios' },
]

const KEY = 'hermes-cockpit.space'
let current: Space = (() => {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'houer' || v === 'pessoal' ? v : 'tudo'
  } catch {
    return 'tudo'
  }
})()
const subs = new Set<() => void>()
const applyAttr = () => {
  if (typeof document !== 'undefined') document.documentElement.dataset.space = current
}
applyAttr()

export function getSpace(): Space {
  return current
}

export function setSpace(s: Space): void {
  current = s
  try {
    localStorage.setItem(KEY, s)
  } catch {
    /* sem storage */
  }
  applyAttr()
  subs.forEach((f) => f())
}

export function useSpace(): Space {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    () => current,
  )
}

export function inSpace(item: ItemSpace, space: Space = current): boolean {
  return space === 'tudo' || item === 'shared' || item === space
}

export function spaceOfBot(name: string): ItemSpace {
  const g = BOT_GROUPS[name]
  if (g === 'trabalho') return 'houer'
  if (g === 'pessoal') return 'pessoal'
  return 'shared'
}

export function spaceOfPath(path: string | null | undefined): ItemSpace {
  if (!path) return 'shared'
  if (/\/Documents\/Houer(\/|$)/i.test(path) || /\/houer[^/]*$/i.test(path)) return 'houer'
  if (/\/Documents\/Alexandre(\/|$)/.test(path)) return 'pessoal'
  return 'shared'
}

/** conta de agenda/inbox do plugin → espaço */
export function spaceOfAccount(conta: string | null | undefined): ItemSpace {
  const c = (conta ?? '').toLowerCase()
  if (c === 'houer' || c === 'work' || c === 'trabalho') return 'houer'
  if (c === 'pessoal' || c === 'personal') return 'pessoal'
  return 'shared'
}
