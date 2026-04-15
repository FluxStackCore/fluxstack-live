#!/usr/bin/env node
/**
 * @fluxstack/live-cli — WebSocket Inspector
 *
 * CLI genérico para inspecionar e interagir com qualquer LiveComponent/Room
 * de um servidor FluxStack em tempo real.
 *
 * Uso:
 *   bunx fluxstack-inspect [opcoes]
 *   npx fluxstack-inspect [opcoes]
 *   bun packages/cli/src/inspector.ts [opcoes]
 *
 * Opcoes:
 *   --url <url>         URL do WebSocket (default: ws://localhost:3000/api/live/ws)
 *   --filter <type>     Filtrar por tipo de mensagem (ex: STATE_DELTA, ROOM_EVENT, BINARY)
 *   --raw               Mostrar JSON bruto sem formatacao
 *   --quiet             Suprimir mensagens de heartbeat/ping/pong
 *   --no-interactive    Desabilitar modo interativo (apenas observar)
 *   --stats-url <url>   URL do endpoint de stats (default: http://localhost:3000/api/live/stats)
 *
 * Comandos interativos (digite no terminal):
 *   help                           Mostrar comandos disponíveis
 *   stats                          Buscar stats do servidor via HTTP
 *   components                     Listar componentes registrados no servidor
 *   mount <ComponentName> [props]  Montar um componente (props = JSON)
 *   unmount [cid]                  Desmontar componente (default: ultimo montado)
 *   action <name> [payload]        Chamar action no componente montado (payload = JSON)
 *   state                          Mostrar estado atual do componente montado
 *   room join <roomId>             Entrar em uma sala
 *   room leave <roomId>            Sair de uma sala
 *   room emit <roomId> <event> [data]  Emitir evento na sala (data = JSON)
 *   auth <payload>                 Enviar mensagem de autenticação (payload = JSON)
 *   send <json>                    Enviar mensagem JSON raw
 *   cid                            Mostrar componentId atual
 *   clear                          Limpar tela
 *   quit / exit                    Encerrar
 */

import { C, color } from './colors.js'
import { formatMessage, formatBinaryFrame, summarize, type FormatOptions } from './format.js'
import { decodeBinaryFrame } from './msgpack.js'
import { createInterface } from 'node:readline'

// ─── Args ──────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): Record<string, string | true> {
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

const args = parseArgs(process.argv.slice(2))

const WS_URL       = (args['url'] as string)       ?? 'ws://localhost:3000/api/live/ws'
const STATS_URL    = (args['stats-url'] as string)  ?? WS_URL.replace(/^ws/, 'http').replace(/\/ws\/?$/, '/stats')
const COMPS_URL    = STATS_URL.replace(/\/stats\/?$/, '/components')
const FILTER       = args['filter'] as string | undefined
const RAW          = 'raw' in args
const QUIET        = 'quiet' in args
const INTERACTIVE  = !('no-interactive' in args)

const formatOpts: FormatOptions = { raw: RAW, quiet: QUIET, filter: FILTER }

// ─── Estado do inspector ───────────────────────────────────────────────────
let ws: WebSocket
let msgCount = 0
let byteCount = 0
const mountedComponents = new Map<string, { name: string; state: any }>()
let activeComponentId = ''

// ─── Helpers ───────────────────────────────────────────────────────────────
function send(obj: any) {
  const str = JSON.stringify(obj)
  const line = formatMessage(obj, 'OUT', formatOpts)
  if (line) console.log(line)
  ws.send(str)
}

function setActiveComponent(cid: string, name?: string) {
  activeComponentId = cid
  if (!mountedComponents.has(cid)) {
    mountedComponents.set(cid, { name: name ?? '?', state: {} })
  }
}

function updateComponentState(cid: string, state: any) {
  const entry = mountedComponents.get(cid)
  if (entry) {
    entry.state = state
  }
}

function applyDelta(cid: string, delta: any) {
  const entry = mountedComponents.get(cid)
  if (!entry) return
  deepMerge(entry.state, delta)
}

function deepMerge(target: any, source: any) {
  if (!source || typeof source !== 'object') return
  for (const [k, v] of Object.entries(source)) {
    if (v === null) {
      // null at top level = real value, nested null = deletion (FluxStack convention)
      delete target[k]
    } else if (typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && target[k] !== null) {
      deepMerge(target[k], v)
    } else {
      target[k] = v
    }
  }
}

// ─── Processar mensagem recebida ───────────────────────────────────────────
function handleMessage(raw: string | Buffer | ArrayBuffer) {
  // Binary frame detection
  let buf: Uint8Array | null = null
  if (raw instanceof ArrayBuffer) {
    buf = new Uint8Array(raw)
  } else if (typeof raw !== 'string' && raw && 'buffer' in raw) {
    const b = raw as Buffer
    buf = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  }

  if (buf) {
    byteCount += buf.byteLength
    msgCount++
    const frame = decodeBinaryFrame(buf)
    if (frame) {
      const line = formatBinaryFrame(frame, formatOpts)
      if (line) console.log(line)
    }
    return
  }

  const text = typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8')
  byteCount += text.length

  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return
  }

  const msgs: any[] = Array.isArray(parsed) ? parsed : [parsed]

  for (const msg of msgs) {
    msgCount++
    const line = formatMessage(msg, 'IN', formatOpts)
    if (line) console.log(line)

    // Track component mounts
    if (msg.type === 'MESSAGE_RESPONSE' && msg.originalType === 'COMPONENT_MOUNT') {
      const cid = msg.result?.componentId ?? msg.componentId
      if (cid) {
        const name = msg.result?.componentName ?? '?'
        setActiveComponent(cid, name)
        if (msg.result?.state) updateComponentState(cid, msg.result.state)
        console.log(color(`\n  [inspector] componente montado: ${name} (${cid})`, C.green, C.bold))
      }
    }

    // Track state inits
    if ((msg.type === 'STATE_INIT' || msg.type === 'STATE_UPDATE') && msg.componentId) {
      if (!activeComponentId) setActiveComponent(msg.componentId)
      const state = msg.payload?.state ?? msg.state ?? msg.result?.state
      if (state) updateComponentState(msg.componentId, state)
    }

    // Track state deltas
    if (msg.type === 'STATE_DELTA' && msg.componentId) {
      const delta = msg.payload?.delta ?? msg.delta
      if (delta) applyDelta(msg.componentId, delta)
    }

    // Track component IDs from mounted responses
    if (msg.type === 'COMPONENT_MOUNTED' && msg.componentId) {
      setActiveComponent(msg.componentId)
      if (msg.result?.state) updateComponentState(msg.componentId, msg.result.state)
    }
  }
}

// ─── Comandos interativos ──────────────────────────────────────────────────
async function execCommand(input: string) {
  const parts = input.trim().split(/\s+/)
  const cmd = parts[0]?.toLowerCase()
  if (!cmd) return

  switch (cmd) {
    case 'help':
      printHelp()
      break

    case 'stats': {
      try {
        const res = await fetch(STATS_URL)
        const data = await res.json()
        console.log(color('\n  [stats]', C.cyan, C.bold))
        console.log(JSON.stringify(data, null, 2))
      } catch (e: any) {
        console.log(color(`  [!] falha ao buscar stats: ${e.message}`, C.red))
      }
      break
    }

    case 'components': {
      try {
        const res = await fetch(COMPS_URL)
        const data = await res.json()
        console.log(color('\n  [components] registrados no servidor:', C.cyan, C.bold))
        if (Array.isArray(data)) {
          for (const name of data) console.log(color(`    - ${name}`, C.white))
        } else {
          console.log(JSON.stringify(data, null, 2))
        }
      } catch (e: any) {
        console.log(color(`  [!] falha ao buscar components: ${e.message}`, C.red))
      }
      break
    }

    case 'mount': {
      const componentName = parts[1]
      if (!componentName) { console.log(color('  uso: mount <ComponentName> [propsJSON]', C.red)); break }
      let props = {}
      if (parts[2]) {
        try { props = JSON.parse(parts.slice(2).join(' ')) } catch { console.log(color('  [!] props JSON invalido', C.red)); break }
      }
      send({
        type: 'COMPONENT_MOUNT',
        payload: { component: componentName, props },
        timestamp: Date.now(),
      })
      break
    }

    case 'unmount': {
      const cid = parts[1] ?? activeComponentId
      if (!cid) { console.log(color('  [!] nenhum componente montado', C.red)); break }
      send({
        type: 'COMPONENT_UNMOUNT',
        componentId: cid,
        timestamp: Date.now(),
      })
      mountedComponents.delete(cid)
      if (activeComponentId === cid) {
        activeComponentId = mountedComponents.keys().next().value ?? ''
      }
      console.log(color(`  [inspector] desmontado: ${cid}`, C.yellow))
      break
    }

    case 'action':
    case 'call': {
      const actionName = parts[1]
      if (!actionName) { console.log(color('  uso: action <name> [payloadJSON]', C.red)); break }
      if (!activeComponentId) { console.log(color('  [!] nenhum componente montado. Use: mount <Nome>', C.red)); break }
      let payload = {}
      if (parts[2]) {
        try { payload = JSON.parse(parts.slice(2).join(' ')) } catch { console.log(color('  [!] payload JSON invalido', C.red)); break }
      }
      send({
        type: 'CALL_ACTION',
        componentId: activeComponentId,
        action: actionName,
        payload,
        timestamp: Date.now(),
      })
      break
    }

    case 'state': {
      const cid = parts[1] ?? activeComponentId
      const entry = mountedComponents.get(cid)
      if (!entry) { console.log(color('  [!] nenhum componente montado ou cid invalido', C.red)); break }
      console.log(color(`\n  [state] ${entry.name} (${cid})`, C.cyan, C.bold))
      console.log(JSON.stringify(entry.state, null, 2))
      break
    }

    case 'room': {
      const sub = parts[1]
      if (sub === 'join') {
        const roomId = parts[2]
        if (!roomId) { console.log(color('  uso: room join <roomId>', C.red)); break }
        if (!activeComponentId) { console.log(color('  [!] nenhum componente montado', C.red)); break }
        send({
          type: 'ROOM_JOIN',
          componentId: activeComponentId,
          roomId,
          timestamp: Date.now(),
        })
      } else if (sub === 'leave') {
        const roomId = parts[2]
        if (!roomId) { console.log(color('  uso: room leave <roomId>', C.red)); break }
        send({
          type: 'ROOM_LEAVE',
          componentId: activeComponentId,
          roomId,
          timestamp: Date.now(),
        })
      } else if (sub === 'emit') {
        const roomId = parts[2]
        const event = parts[3]
        if (!roomId || !event) { console.log(color('  uso: room emit <roomId> <event> [dataJSON]', C.red)); break }
        let data = {}
        if (parts[4]) {
          try { data = JSON.parse(parts.slice(4).join(' ')) } catch { console.log(color('  [!] data JSON invalido', C.red)); break }
        }
        send({
          type: 'ROOM_EMIT',
          componentId: activeComponentId,
          roomId,
          event,
          data,
          timestamp: Date.now(),
        })
      } else {
        console.log(color('  uso: room [join|leave|emit] <roomId> ...', C.red))
      }
      break
    }

    case 'auth': {
      let payload = {}
      if (parts[1]) {
        try { payload = JSON.parse(parts.slice(1).join(' ')) } catch { console.log(color('  [!] payload JSON invalido', C.red)); break }
      }
      send({
        type: 'AUTH',
        componentId: activeComponentId || '',
        payload,
        timestamp: Date.now(),
      })
      break
    }

    case 'send': {
      try {
        const raw = JSON.parse(parts.slice(1).join(' '))
        send(raw)
      } catch { console.log(color('  [!] JSON invalido', C.red)) }
      break
    }

    case 'cid':
      console.log(color(`\n  componentId ativo: ${activeComponentId || '(nenhum)'}`, C.cyan))
      if (mountedComponents.size > 1) {
        console.log(color('  todos montados:', C.dim))
        for (const [cid, entry] of mountedComponents) {
          const active = cid === activeComponentId ? ' *' : ''
          console.log(color(`    ${entry.name} (${cid})${active}`, C.white))
        }
      }
      break

    case 'use': {
      const cid = parts[1]
      if (!cid) { console.log(color('  uso: use <componentId>', C.red)); break }
      const found = [...mountedComponents.entries()].find(([id]) => id === cid || id.startsWith(cid))
      if (found) {
        activeComponentId = found[0]
        console.log(color(`  [inspector] componente ativo: ${found[1].name} (${found[0]})`, C.green))
      } else {
        console.log(color(`  [!] componentId nao encontrado: ${cid}`, C.red))
      }
      break
    }

    case 'info': {
      console.log(color('\n  [info]', C.cyan, C.bold))
      console.log(color(`  url:        ${WS_URL}`, C.white))
      console.log(color(`  mensagens:  ${msgCount}`, C.white))
      console.log(color(`  bytes:      ${(byteCount / 1024).toFixed(1)} KB`, C.white))
      console.log(color(`  montados:   ${mountedComponents.size}`, C.white))
      console.log(color(`  ativo:      ${activeComponentId || '(nenhum)'}`, C.white))
      break
    }

    case 'clear':
      console.clear()
      break

    case 'quit':
    case 'exit':
      ws.close()
      process.exit(0)

    default:
      console.log(color(`  [!] comando desconhecido: ${cmd}`, C.red))
      console.log(color('  digite "help" para ver comandos disponíveis', C.gray))
  }
}

function printHelp() {
  console.log(color(`
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
`, C.reset))
}

// ─── Banner ────────────────────────────────────────────────────────────────
function printBanner() {
  console.log(color(`
  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
  \u2551  FluxStack WebSocket Inspector            \u2551
  \u2551  @fluxstack/live-cli                      \u2551
  \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d`, C.cyan, C.bold))
  console.log(color(`  URL:     ${WS_URL}`, C.white))
  if (FILTER) console.log(color(`  Filtro:  ${FILTER}`, C.white))
  if (RAW) console.log(color(`  Modo:    raw`, C.white))
  if (QUIET) console.log(color(`  Quiet:   ping/pong suprimidos`, C.white))
  if (!INTERACTIVE) console.log(color(`  Modo:    observação (não interativo)`, C.white))
  console.log(color(`  Digite "help" para ver comandos\n`, C.gray))
}

// ─── Conexão ───────────────────────────────────────────────────────────────
printBanner()

ws = new WebSocket(WS_URL)

ws.binaryType = 'arraybuffer'

ws.addEventListener('open', () => {
  console.log(color('  [inspector] conectado!\n', C.green, C.bold))

  if (INTERACTIVE) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '' })

    // Prompt sutil
    const showPrompt = () => process.stdout.write(color('> ', C.gray))

    rl.on('line', async (line) => {
      if (line.trim()) await execCommand(line)
      showPrompt()
    })

    rl.on('close', () => {
      ws.close()
      process.exit(0)
    })

    showPrompt()
  }
})

ws.addEventListener('message', (ev) => {
  handleMessage(ev.data as any)
})

ws.addEventListener('error', (ev) => {
  console.log(color(`  [inspector] erro: ${(ev as any).message ?? ev}`, C.red, C.bold))
})

ws.addEventListener('close', (ev) => {
  console.log(color(`\n  [inspector] desconectado — code: ${(ev as any).code}  reason: ${(ev as any).reason || '\u2014'}`, C.red))
  console.log(color(`  total: ${msgCount} mensagens, ${(byteCount / 1024).toFixed(1)} KB`, C.gray))
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log(color('\n  [inspector] encerrando...', C.yellow))
  ws.close()
  process.exit(0)
})
