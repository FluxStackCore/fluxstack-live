'use client'
// <Live.Boundary> e <Live.Status> — helpers de UI de estado dos Live Components.
//
// Eliminam o boilerplate repetido em cada componente ("se desconectado mostra X,
// se loading mostra Y, se erro mostra Z"). O dev passa o proxy Live e o Boundary
// renderiza o estado certo a partir de $status; os children só aparecem quando
// está pronto (synced/connected).
//
// Uso:
//   const counter = Live.use(Counter)
//   <Live.Boundary live={counter}>
//     <p>{counter.$state.count}</p>   // só renderiza quando pronto
//   </Live.Boundary>
//
//   <Live.Status live={counter} />     // pill Connected/Offline pronto

import type { ReactNode } from 'react'

/** Subconjunto do proxy Live que os helpers consomem (evita acoplar ao tipo completo). */
interface LiveLike {
  $status: 'synced' | 'disconnected' | 'connecting' | 'reconnecting' | 'loading' | 'mounting' | 'error'
  $connected: boolean
  $error: string | null
}

/** Qual slot o Boundary deve renderizar dado o estado. Função pura (testável sem render). */
export type BoundarySlot = 'error' | 'loading' | 'offline' | 'children'

export function resolveBoundarySlot(
  live: Pick<LiveLike, '$status' | '$connected'>,
  showWhileOffline = false,
): BoundarySlot {
  const status = live.$status
  if (status === 'error') return 'error'
  if (status === 'connecting' || status === 'mounting' || status === 'loading' || status === 'reconnecting') {
    return 'loading'
  }
  if (!live.$connected && !showWhileOffline) return 'offline'
  return 'children'
}

export interface LiveBoundaryProps {
  live: LiveLike
  children: ReactNode
  /** UI enquanto conecta/monta. Default: spinner discreto. */
  loading?: ReactNode
  /** UI quando há erro. Recebe a mensagem. Default: caixa de erro. */
  error?: (message: string) => ReactNode
  /** UI quando offline/desconectado. Default: aviso de reconexão. */
  offline?: ReactNode
  /** Mostra os children mesmo desconectado (ex: dados em cache). Default: false. */
  showWhileOffline?: boolean
}

function DefaultLoading() {
  return (
    <div className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] p-8 text-sm text-gray-500">
      <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-current opacity-60" />
      Carregando…
    </div>
  )
}

function DefaultError({ message }: { message: string }) {
  return (
    <div className="w-full rounded-lg border border-red-400/25 bg-red-400/10 p-4 text-sm text-red-200">
      <strong className="font-semibold">Erro:</strong> {message}
    </div>
  )
}

function DefaultOffline() {
  return (
    <div className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-400/25 bg-amber-400/10 p-6 text-sm text-amber-200">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-300" />
      Reconectando…
    </div>
  )
}

/**
 * Renderiza a UI certa conforme o estado do Live, mostrando os children só
 * quando está pronto. Ordem: erro > conectando/montando > offline > pronto.
 */
export function LiveBoundary({ live, children, loading, error, offline, showWhileOffline = false }: LiveBoundaryProps) {
  switch (resolveBoundarySlot(live, showWhileOffline)) {
    case 'error': {
      const msg = live.$error ?? 'Erro desconhecido'
      return <>{error ? error(msg) : <DefaultError message={msg} />}</>
    }
    case 'loading':
      return <>{loading ?? <DefaultLoading />}</>
    case 'offline':
      return <>{offline ?? <DefaultOffline />}</>
    default:
      return <>{children}</>
  }
}

export interface LiveStatusProps {
  live: LiveLike
  /** Labels customizados. */
  connectedLabel?: string
  offlineLabel?: string
  className?: string
}

/** Pill de status de conexão pronto (Connected/Offline). Substitui o ConnectionPill copiado. */
export function LiveStatus({ live, connectedLabel = 'Connected', offlineLabel = 'Offline', className = '' }: LiveStatusProps) {
  const ok = live.$connected
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs ${
        ok
          ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200'
          : 'border-red-400/25 bg-red-400/10 text-red-200'
      } ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-300' : 'bg-red-300'}`} />
      {ok ? connectedLabel : offlineLabel}
    </span>
  )
}
