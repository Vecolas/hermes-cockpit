import type { HermesRpc } from '../../lib/rpc'

// STUB do scaffold — Armazenamento: sessões (stats, busca, apagar, vazias), disco de ~/.hermes, limpeza. Montado como aba da OpsView.
// CONTRATO: nome do export e props são fixos (App/registry já montam assim).
export function StoragePanel(props: { rpc: HermesRpc | null }) {
  void props
  return <div className="p-4 text-[11px] text-faint">StoragePanel: em construção</div>
}
