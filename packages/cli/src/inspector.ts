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
import { InspectorSession, parseArgs, resolveConfig } from './session.js'
import { createInterface } from 'node:readline'

// Toda a lógica (args, rastreio de estado, comandos, formatação) vive em
// session.ts e é testada sem terminal; aqui fica só o I/O: WebSocket,
// readline e process.

const config = resolveConfig(parseArgs(process.argv.slice(2)))
const WS_URL = config.wsUrl
const FILTER = config.filter
const RAW = config.raw
const QUIET = config.quiet
const INTERACTIVE = config.interactive

/** Campos do CloseEvent lidos no log de desconexão (lib ES2022 não traz tipos DOM). */
type CloseLike = Event & { code?: number; reason?: string }

let ws: WebSocket

const session = new InspectorSession(config, {
  send: (text) => ws.send(text),
  log: (line) => console.log(line),
  clear: () => console.clear(),
})

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
      if (line.trim() && (await session.execCommand(line)) === 'quit') {
        ws.close()
        process.exit(0)
      }
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
  session.handleMessage(ev.data as string | ArrayBuffer)
})

ws.addEventListener('error', (ev) => {
  console.log(color(`  [inspector] erro: ${(ev as Event & { message?: string }).message ?? ev}`, C.red, C.bold))
})

ws.addEventListener('close', (ev) => {
  console.log(color(`\n  [inspector] desconectado — code: ${(ev as CloseLike).code}  reason: ${(ev as CloseLike).reason || '\u2014'}`, C.red))
  console.log(color(`  total: ${session.msgCount} mensagens, ${(session.byteCount / 1024).toFixed(1)} KB`, C.gray))
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log(color('\n  [inspector] encerrando...', C.yellow))
  ws.close()
  process.exit(0)
})
