// Infra de teste compartilhada do @fluxstack/live-vue.
//
// - `mountWithLive`: monta um app Vue (renderer custom, sem DOM) com
//   `provideLiveConnection` na raiz e o composable do teste num filho —
//   a mesma árvore de uma app real (provide → inject).
// - `FakeTransport`: ClientTransport controlado pelo teste, para dirigir o
//   LiveConnection sem servidor (open/close/mensagens do servidor à mão).
import { createRenderer, defineComponent, h, nextTick, ref, type App } from 'vue'
import type {
  ClientTransport,
  ClientTransportFactory,
  ClientTransportHandlers,
  LiveConnectionOptions,
} from '@fluxstack/live-client'
import { provideLiveConnection, type LiveConnectionContext } from '../index'

type HostNode = { children: HostNode[]; parent: HostNode | null; text?: string }

const newNode = (text?: string): HostNode => ({ children: [], parent: null, text })

function detach(node: HostNode): void {
  if (!node.parent) return
  const siblings = node.parent.children
  const i = siblings.indexOf(node)
  if (i >= 0) siblings.splice(i, 1)
  node.parent = null
}

// Renderer "headless": uma árvore mínima em memória basta para o Vue montar,
// atualizar e desmontar componentes sem DOM.
const { createApp } = createRenderer<HostNode, HostNode>({
  patchProp() {},
  insert(child, parent, anchor) {
    detach(child)
    const i = anchor ? parent.children.indexOf(anchor) : -1
    if (i >= 0) parent.children.splice(i, 0, child)
    else parent.children.push(child)
    child.parent = parent
  },
  remove: detach,
  createElement: () => newNode(),
  createText: (text) => newNode(text),
  createComment: (text) => newNode(text),
  setText(node, text) { node.text = text },
  setElementText(node, text) { node.text = text },
  parentNode: (node) => node.parent,
  nextSibling: (node) => {
    if (!node.parent) return null
    const siblings = node.parent.children
    return siblings[siblings.indexOf(node) + 1] ?? null
  },
})

/** createApp do renderer headless (para montar árvores arbitrárias nos testes). */
export const createHeadlessApp = createApp
export const newHostNode = () => newNode()

export interface Mounted<T> {
  ctx: LiveConnectionContext
  child: T
  app: App<HostNode>
  /** desmonta só o filho (como um `v-if` falso) — a conexão continua viva */
  hideChild: () => Promise<void>
  unmount: () => void
}

/** Monta `provideLiveConnection(options)` na raiz e `useChild()` num filho. */
export function mountWithLive<T>(options: LiveConnectionOptions, useChild: () => T): Mounted<T> {
  let ctx!: LiveConnectionContext
  let child!: T
  const Child = defineComponent({
    setup() {
      child = useChild()
      return () => null
    },
  })
  const showChild = ref(true)
  const Root = defineComponent({
    setup() {
      ctx = provideLiveConnection(options)
      return () => (showChild.value ? h(Child) : null)
    },
  })
  const app = createApp(Root)
  app.mount(newNode())
  let mounted = true
  return {
    ctx,
    child,
    app,
    hideChild: async () => {
      showChild.value = false
      await nextTick()
    },
    unmount: () => {
      if (!mounted) return
      mounted = false
      app.unmount()
    },
  }
}

/** Transporte fake: o teste decide quando abre, fecha e o que o "servidor" manda. */
export class FakeTransport implements ClientTransport {
  readonly kind = 'fake'
  isOpen = false
  isConnecting = false
  handlers: ClientTransportHandlers | null = null
  /** frames enviados pelo cliente (JSON já parseado) */
  sent: Array<Record<string, unknown>> = []
  closed = false

  open(handlers: ClientTransportHandlers): void {
    this.handlers = handlers
    this.isConnecting = true
  }

  send(data: string | ArrayBuffer): void {
    if (!this.isOpen) throw new Error('fake transport not open')
    if (typeof data === 'string') this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return
    this.closed = true
    this.isOpen = false
    this.isConnecting = false
    this.handlers?.onClose(code, reason)
  }

  // ── controles do teste ──
  accept(): void {
    this.isConnecting = false
    this.isOpen = true
    this.handlers?.onOpen()
  }

  serverSend(msg: unknown): void {
    this.handlers?.onMessage(JSON.stringify(msg))
  }

  fail(message = 'boom'): void {
    this.handlers?.onError(new Error(message))
  }

  /** queda do lado do servidor (não intencional para o cliente) */
  drop(code = 1006): void {
    this.close(code, 'dropped')
  }

  /** último frame enviado com esse `type` */
  lastSent(type: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((m) => m.type === type)
  }
}

/** Fábrica que registra cada transporte criado (1 por tentativa de conexão). */
export function fakeTransportFactory(): { factory: ClientTransportFactory; created: FakeTransport[]; current: () => FakeTransport } {
  const created: FakeTransport[] = []
  const factory: ClientTransportFactory = () => {
    const t = new FakeTransport()
    created.push(t)
    return t
  }
  return {
    factory,
    created,
    current: () => {
      const t = created.at(-1)
      if (!t) throw new Error('nenhum transporte criado ainda')
      return t
    },
  }
}

export const flush = () => new Promise<void>((r) => setTimeout(r, 0))

export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condição')
    await new Promise((r) => setTimeout(r, 5))
  }
}
