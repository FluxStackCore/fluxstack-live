// @fluxstack/live - Renovação throttled do signedState
//
// O `signedState` (estado assinado por HMAC que o cliente guarda para
// re-hidratar depois de reconectar) era emitido só no mount. A re-hidratação
// então voltava ao snapshot do mount, perdendo tudo que mudou depois.
//
// Este módulo decide QUANDO re-assinar. Assinar custa HMAC (+ gzip acima de
// 1KB, + AES-GCM se a cripto estiver ligada), então não se assina a cada
// delta: no máximo uma vez por `intervalMs` por componente.
//
//   - leading (adiado 1 tick): o primeiro delta depois de uma janela ociosa
//     agenda a assinatura para o próximo macrotask — pega o lote síncrono
//     inteiro de uma action (vários `this.state.x = ...` seguidos), não o meio.
//   - trailing: deltas dentro da janela só marcam "tem algo novo"; o timer já
//     agendado assina o estado de QUANDO DISPARA, ou seja, o último da rajada.
//
// Resultado: uma rajada de N deltas gera ~2 assinaturas (1 + 1 por janela
// adicional), e a última sempre reflete o estado final. Componente ocioso
// (sem deltas) não assina nada.
//
// O módulo não conhece assinatura nem transporte: o registry passa `renew`.

export interface SignedStateRenewerOptions {
  /** Janela mínima entre duas assinaturas do mesmo componente (ms). `<= 0` desliga. */
  intervalMs: number
  /** Re-assina o componente e envia ao(s) cliente(s). Chamado fora do caminho do delta. */
  renew: (componentId: string) => void
  /** Relógio injetável (testes). */
  now?: () => number
}

interface RenewEntry {
  /** Quando a última assinatura deste componente foi emitida (mount, renovação, resync...). */
  lastSignedAt: number
  timer: ReturnType<typeof setTimeout> | null
}

export class SignedStateRenewer {
  private readonly entries = new Map<string, RenewEntry>()
  private readonly intervalMs: number
  private readonly renew: (componentId: string) => void
  private readonly now: () => number

  constructor(opts: SignedStateRenewerOptions) {
    this.intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : 0
    this.renew = opts.renew
    this.now = opts.now ?? Date.now
  }

  get enabled(): boolean {
    return this.intervalMs > 0
  }

  /**
   * Uma assinatura acabou de ser emitida por outro caminho (mount, rehydrate,
   * resync, entrada em singleton). Abre a janela a partir de agora — o próximo
   * delta espera o fim dela. Um timer já agendado é mantido: ele assina o
   * estado mais novo, então no pior caso sai uma assinatura redundante.
   */
  markSigned(componentId: string): void {
    if (!this.enabled) return
    const entry = this.entries.get(componentId)
    if (entry) entry.lastSignedAt = this.now()
    else this.entries.set(componentId, { lastSignedAt: this.now(), timer: null })
  }

  /** O estado do componente mudou (STATE_DELTA JSON ou binário). */
  notifyDelta(componentId: string): void {
    if (!this.enabled) return
    let entry = this.entries.get(componentId)
    if (!entry) {
      entry = { lastSignedAt: 0, timer: null }
      this.entries.set(componentId, entry)
    }
    if (entry.timer) return // já tem assinatura agendada: ela pega este delta (trailing)

    const delay = Math.max(0, entry.lastSignedAt + this.intervalMs - this.now())
    const scheduled = entry
    scheduled.timer = setTimeout(() => this.fire(componentId, scheduled), delay)
    // Não segurar o processo vivo só por causa de uma renovação pendente.
    const t = scheduled.timer as { unref?: () => void }
    if (typeof t.unref === 'function') t.unref()
  }

  private fire(componentId: string, entry: RenewEntry): void {
    entry.timer = null
    // Componente esquecido (unmount/cleanup) enquanto o timer corria.
    if (this.entries.get(componentId) !== entry) return
    entry.lastSignedAt = this.now()
    try {
      this.renew(componentId)
    } catch (err) {
      console.error(`[LiveComponents] signedState renewal failed for ${componentId}:`, err instanceof Error ? err.message : err)
    }
  }

  /** O componente saiu (unmount/cleanup): cancela a renovação pendente. */
  forget(componentId: string): void {
    const entry = this.entries.get(componentId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    this.entries.delete(componentId)
  }

  /** Cancela tudo (shutdown). */
  stop(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    this.entries.clear()
  }

  /** Quantos componentes têm renovação pendente (diagnóstico/testes). */
  get pendingCount(): number {
    let n = 0
    for (const entry of this.entries.values()) if (entry.timer) n++
    return n
  }
}
