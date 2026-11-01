import type { HermesRpc } from '../../lib/rpc'

// STUB do scaffold — Central Ops (área central): modelos, portas, aplicações, projetos/repos, containers, armazenamento.
// CONTRATO: nome do export e props são fixos (App/registry já montam assim).
export function OpsView(props: { rpc: HermesRpc | null }) {
  void props
  return <div className="p-4 text-[11px] text-faint">OpsView: em construção</div>
}
