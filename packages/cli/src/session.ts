// @fluxstack/live-cli — Lógica do inspector, sem I/O.
//
// Tudo o que o `inspector.ts` faz, menos abrir socket, terminal e processo:
// parse de argumentos, rastreio de componentes montados/estado, formatação de
// mensagens recebidas e execução dos comandos interativos. O I/O entra por
// `InspectorIO` — o CLI liga isso em WebSocket + console; os testes, num
// LiveServer real em memória.

import { C, color } from './colors.js'
import { formatMessage, formatBinaryFrame, type FormatOptions, type WireMessage } from './format.js'
import { decodeBinaryFrame } from './msgpack.js'

// ─── Args ──────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const eqIdx = key.indexOf('=')
      if (eqIdx !== -1) {
        result[key.slice(0, eqIdx)] = key.slice(eqIdx + 1)
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        result[key] = argv[++i]
      } else {
        result[key] = true
      }
    }
  }
  return result
}

export interface InspectorConfig {
  wsUrl: string
  statsUrl: string
  componentsUrl: string
  filter?: string
  raw: boolean
  quiet: boolean
  interactive: boolean
}

const DEFAULT_WS_URL = 'ws://localhost:3000/api/live/ws'

/** Monta a configuração a partir dos argumentos (`--url`, `--stats-url`, `--filter`, ...). */
export function resolveConfig(args: Record<string, string | true>): InspectorConfig {
  const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined)
  const wsUrl = str(args['url']) ?? DEFAULT_WS_URL
  const statsUrl = str(args['stats-url']) ?? wsUrl.replace(/^ws/, 'http').replace(/\/ws\/?$/, '/stats')
  return {
    wsUrl,
    statsUrl,
    componentsUrl: statsUrl.replace(/\/stats\/?$/, '/components'),
    filter: str(args['filter']),
    raw: 'raw' in args,
    quiet: 'quiet' in args,
    interactive: !('no-interactive' in args),
  }
}

// ─── Estado ────────────────────────────────────────────────────────────────

export type ComponentState = Record<string, unknown>

/**
 * Aplica um STATE_DELTA no estado espelhado (muta `target`), com a mesma
 * semântica do core/clients: `null` no topo é valor real; `null` aninhado
 * remove a chave; objetos planos mesclam; o resto substitui.
 */
export function applyStateDelta(target: ComponentState, delta: unknown, depth = 0): void {
  if (!delta || typeof delta !== 'object') return
  for (const [k, v] of Object.entries(delta) as [string, unknown][]) {
    const current = target[k]
    if (v === undefined) continue
    if (v === null) {
      if (depth === 0) target[k] = null
      else delete target[k]
    } else if (typeof v === 'object' && !Array.isArray(v) && typeof current === 'object' && current !== null && !Array.isArray(current)) {
      applyStateDelta(current as ComponentState, v, depth + 1)
    } else {
      target[k] = v
    }
  }
}

// ─── Sessão ────────────────────────────────────────────────────────────────

export interface InspectorIO {
  /** envia um frame de texto ao servidor */
  send(text: string): void
  /** escreve uma linha no terminal */
  log(line: string): void
  /** fetch para `stats`/`components` (padrão: global) */
  fetch?: typeof fetch
  /** limpa a tela (comando `clear`) */
  clear?: () => void
}

export type CommandResult = 'quit' | undefined

export class InspectorSession {
  msgCount = 0
  byteCount = 0
  activeComponentId = ''
  readonly mountedComponents = new Map<string, { name: string; state: ComponentState }>()
  /** requestId do COMPONENT_MOUNT → nome do componente (a resposta do servidor não traz o nome) */
  private readonly pendingMounts = new Map<string, string>()
  private requestSeq = 0
  private readonly formatOpts: FormatOptions

  constructor(readonly config: InspectorConfig, private readonly io: InspectorIO) {
    this.formatOpts = { raw: config.raw, quiet: config.quiet, filter: config.filter }
  }

  private nextRequestId(): string {
    return `inspect-${++this.requestSeq}`
  }

  /** Envia uma mensagem JSON ao servidor e ecoa a linha formatada. */
  send(obj: WireMessage): void {
    const line = formatMessage(obj, 'OUT', this.formatOpts)
    if (line) this.io.log(line)
    this.io.send(JSON.stringify(obj))
  }

  private setActiveComponent(cid: string, name?: string): void {
    this.activeComponentId = cid
    const existing = this.mountedComponents.get(cid)
    if (!existing) this.mountedComponents.set(cid, { name: name ?? '?', state: {} })
    else if (name && existing.name === '?') existing.name = name
  }

  private updateComponentState(cid: string, state: unknown): void {
    const entry = this.mountedComponents.get(cid)
    // State vem do servidor (JSON) e é sempre um objeto no protocolo
    if (entry && state && typeof state === 'object') entry.state = { ...(state as ComponentState) }
  }

  // ─── Mensagens recebidas ────────────────────────────────────────────────

  handleMessage(raw: string | ArrayBuffer | Uint8Array): void {
    if (typeof raw !== 'string') {
      const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
      this.byteCount += buf.byteLength
      this.msgCount++
      const frame = decodeBinaryFrame(buf)
      if (frame) {
        const line = formatBinaryFrame(frame, this.formatOpts)
        if (line) this.io.log(line)
      }
      return
    }

    this.byteCount += raw.length

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }

    // JSON do servidor tratado como WireMessage (tudo opcional): o inspector só exibe
    const msgs = (Array.isArray(parsed) ? parsed : [parsed]) as WireMessage[]
    for (const msg of msgs) this.handleJson(msg)
  }

  private handleJson(msg: WireMessage): void {
    this.msgCount++
    const line = formatMessage(msg, 'IN', this.formatOpts)
    if (line) this.io.log(line)

    // Resposta de mount: o servidor responde MESSAGE_RESPONSE com o mesmo
    // requestId e `result: { componentId, initialState }` (sem originalType).
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined
    const mountName = requestId ? this.pendingMounts.get(requestId) : undefined
    const isMountResponse = msg.type === 'MESSAGE_RESPONSE' && (mountName !== undefined || msg.originalType === 'COMPONENT_MOUNT')
    if (isMountResponse) {
      if (requestId) this.pendingMounts.delete(requestId)
      const cid = msg.result?.componentId ?? msg.componentId
      if (msg.success !== false && cid) {
        const name = mountName ?? msg.result?.componentName ?? '?'
        this.setActiveComponent(cid, name)
        const state = msg.result?.initialState ?? msg.result?.state
        if (state) this.updateComponentState(cid, state)
        this.io.log(color(`\n  [inspector] componente montado: ${name} (${cid})`, C.green, C.bold))
      }
    }

    if ((msg.type === 'STATE_INIT' || msg.type === 'STATE_UPDATE') && msg.componentId) {
      if (!this.activeComponentId) this.setActiveComponent(msg.componentId)
      const state = msg.payload?.state ?? msg.state ?? msg.result?.state
      if (state) this.updateComponentState(msg.componentId, state)
    }

    if (msg.type === 'STATE_DELTA' && msg.componentId) {
      const delta = msg.payload?.delta ?? msg.delta
      const entry = this.mountedComponents.get(msg.componentId)
      if (delta && entry) applyStateDelta(entry.state, delta)
    }

    if (msg.type === 'COMPONENT_MOUNTED' && msg.componentId) {
      this.setActiveComponent(msg.componentId)
      if (msg.result?.state) this.updateComponentState(msg.componentId, msg.result.state)
    }
  }

  // ─── Comandos ───────────────────────────────────────────────────────────

  private err(text: string): void {
    this.io.log(color(text, C.red))
  }

  /** JSON opcional a partir de `parts[from]` (junta o resto). `null` = inválido (já avisou). */
  private parseJsonArg(parts: string[], from: number, label: string): Record<string, unknown> | null {
    if (!parts[from]) return {}
    try {
      return JSON.parse(parts.slice(from).join(' ')) as Record<string, unknown>
    } catch {
      this.err(`  [!] ${label} JSON invalido`)
      return null
    }
  }

  async execCommand(input: string): Promise<CommandResult> {
    const parts = input.trim().split(/\s+/)
    const cmd = parts[0]?.toLowerCase()
    if (!cmd) return undefined

    switch (cmd) {
      case 'help':
        this.io.log(helpText())
        break

      case 'stats':
      case 'components': {
        const url = cmd === 'stats' ? this.config.statsUrl : this.config.componentsUrl
        try {
          const res = await (this.io.fetch ?? fetch)(url)
          const data: unknown = await res.json()
          if (cmd === 'stats') {
            this.io.log(color('\n  [stats]', C.cyan, C.bold))
            this.io.log(JSON.stringify(data, null, 2))
          } else {
            this.io.log(color('\n  [components] registrados no servidor:', C.cyan, C.bold))
            if (Array.isArray(data)) {
              for (const name of data) this.io.log(color(`    - ${String(name)}`, C.white))
            } else {
              this.io.log(JSON.stringify(data, null, 2))
            }
          }
        } catch (e: unknown) {
          this.err(`  [!] falha ao buscar ${cmd}: ${errorMessage(e)}`)
        }
        break
      }

      case 'mount': {
        const componentName = parts[1]
        if (!componentName) { this.err('  uso: mount <ComponentName> [propsJSON]'); break }
        const props = this.parseJsonArg(parts, 2, 'props')
        if (!props) break
        const requestId = this.nextRequestId()
        this.pendingMounts.set(requestId, componentName)
        this.send({
          type: 'COMPONENT_MOUNT',
          payload: { component: componentName, props },
          requestId,
          expectResponse: true,
          timestamp: Date.now(),
        })
        break
      }

      case 'unmount': {
        const cid = parts[1] ?? this.activeComponentId
        if (!cid) { this.err('  [!] nenhum componente montado'); break }
        this.send({ type: 'COMPONENT_UNMOUNT', componentId: cid, timestamp: Date.now() })
        this.mountedComponents.delete(cid)
        if (this.activeComponentId === cid) {
          this.activeComponentId = this.mountedComponents.keys().next().value ?? ''
        }
        this.io.log(color(`  [inspector] desmontado: ${cid}`, C.yellow))
        break
      }

      case 'action':
      case 'call': {
        const actionName = parts[1]
        if (!actionName) { this.err('  uso: action <name> [payloadJSON]'); break }
        if (!this.activeComponentId) { this.err('  [!] nenhum componente montado. Use: mount <Nome>'); break }
        const payload = this.parseJsonArg(parts, 2, 'payload')
        if (!payload) break
        this.send({
          type: 'CALL_ACTION',
          componentId: this.activeComponentId,
          action: actionName,
          payload,
          // sem expectResponse o servidor não manda ACTION_RESPONSE (só o delta)
          requestId: this.nextRequestId(),
          expectResponse: true,
          timestamp: Date.now(),
        })
        break
      }

      case 'state': {
        const cid = parts[1] ?? this.activeComponentId
        const entry = this.mountedComponents.get(cid)
        if (!entry) { this.err('  [!] nenhum componente montado ou cid invalido'); break }
        this.io.log(color(`\n  [state] ${entry.name} (${cid})`, C.cyan, C.bold))
        this.io.log(JSON.stringify(entry.state, null, 2))
        break
      }

      case 'room': {
        const sub = parts[1]
        const roomId = parts[2]
        if (sub === 'join' || sub === 'leave') {
          if (!roomId) { this.err(`  uso: room ${sub} <roomId>`); break }
          if (!this.activeComponentId) { this.err('  [!] nenhum componente montado'); break }
          this.send({
            type: sub === 'join' ? 'ROOM_JOIN' : 'ROOM_LEAVE',
            componentId: this.activeComponentId,
            roomId,
            requestId: this.nextRequestId(),
            timestamp: Date.now(),
          })
        } else if (sub === 'emit') {
          const event = parts[3]
          if (!roomId || !event) { this.err('  uso: room emit <roomId> <event> [dataJSON]'); break }
          if (!this.activeComponentId) { this.err('  [!] nenhum componente montado'); break }
          const data = this.parseJsonArg(parts, 4, 'data')
          if (!data) break
          // o servidor lê event/data de `payload` (no topo eram recusados com ERROR)
          this.send({
            type: 'ROOM_EMIT',
            componentId: this.activeComponentId,
            roomId,
            payload: { event, data },
            requestId: this.nextRequestId(),
            timestamp: Date.now(),
          })
        } else {
          this.err('  uso: room [join|leave|emit] <roomId> ...')
        }
        break
      }

      case 'auth': {
        const payload = this.parseJsonArg(parts, 1, 'payload')
        if (!payload) break
        this.send({
          type: 'AUTH',
          componentId: this.activeComponentId || '',
          payload,
          requestId: this.nextRequestId(),
          timestamp: Date.now(),
        })
        break
      }

      case 'send': {
        try {
          const raw = JSON.parse(parts.slice(1).join(' ')) as WireMessage
          this.send(raw)
        } catch { this.err('  [!] JSON invalido') }
        break
      }

      case 'cid':
        this.io.log(color(`\n  componentId ativo: ${this.activeComponentId || '(nenhum)'}`, C.cyan))
        if (this.mountedComponents.size > 1) {
          this.io.log(color('  todos montados:', C.dim))
          for (const [cid, entry] of this.mountedComponents) {
            const active = cid === this.activeComponentId ? ' *' : ''
            this.io.log(color(`    ${entry.name} (${cid})${active}`, C.white))
          }
        }
        break

      case 'use': {
        const cid = parts[1]
        if (!cid) { this.err('  uso: use <componentId>'); break }
        const found = [...this.mountedComponents.entries()].find(([id]) => id === cid || id.startsWith(cid))
        if (found) {
          this.activeComponentId = found[0]
          this.io.log(color(`  [inspector] componente ativo: ${found[1].name} (${found[0]})`, C.green))
        } else {
          this.err(`  [!] componentId nao encontrado: ${cid}`)
        }
        break
      }

      case 'info':
        this.io.log(color('\n  [info]', C.cyan, C.bold))
        this.io.log(color(`  url:        ${this.config.wsUrl}`, C.white))
        this.io.log(color(`  mensagens:  ${this.msgCount}`, C.white))
        this.io.log(color(`  bytes:      ${(this.byteCount / 1024).toFixed(1)} KB`, C.white))
        this.io.log(color(`  montados:   ${this.mountedComponents.size}`, C.white))
        this.io.log(color(`  ativo:      ${this.activeComponentId || '(nenhum)'}`, C.white))
        break

      case 'clear':
        this.io.clear?.()
        break

      case 'quit':
      case 'exit':
        return 'quit'

      default:
        this.err(`  [!] comando desconhecido: ${cmd}`)
        this.io.log(color('  digite "help" para ver comandos disponíveis', C.gray))
    }
    return undefined
  }
}

/** Mesmo comportamento de antes (`e.message`), sem `any`. */
function errorMessage(e: unknown): string | undefined {
  return (e as { message?: string } | null | undefined)?.message
}

export function helpText(): string {
  return color(`
  ${C.bold}Comandos disponíveis:${C.reset}

  ${color('help', C.cyan)}                                   Mostrar esta ajuda
  ${color('stats', C.cyan)}                                  Buscar stats do servidor via HTTP
  ${color('components', C.cyan)}                             Listar componentes registrados
  ${color('mount', C.cyan)} <Nome> [propsJSON]               Montar um LiveComponent
  ${color('unmount', C.cyan)} [cid]                          Desmontar componente
  ${color('action', C.cyan)} <nome> [payloadJSON]            Chamar action no componente ativo
  ${color('state', C.cyan)} [cid]                            Ver estado do componente
  ${color('room join', C.cyan)} <roomId>                     Entrar em uma sala
  ${color('room leave', C.cyan)} <roomId>                    Sair de uma sala
  ${color('room emit', C.cyan)} <roomId> <event> [dataJSON]  Emitir evento na sala
  ${color('auth', C.cyan)} <payloadJSON>                     Autenticar
  ${color('send', C.cyan)} <json>                            Enviar mensagem raw
  ${color('cid', C.cyan)}                                    Ver componentId ativo
  ${color('use', C.cyan)} <cid>                              Trocar componente ativo
  ${color('info', C.cyan)}                                   Info da sessão
  ${color('clear', C.cyan)}                                  Limpar tela
  ${color('quit', C.cyan)}                                   Sair
`, C.reset)
}
