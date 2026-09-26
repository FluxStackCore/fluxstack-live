/**
 * Tipo interno: um plugin com o `TConfig` apagado.
 *
 * Registry, discovery, executor e manager armazenam/ordenam/invocam plugins
 * sem ler `context.config` (os hooks são chamados via `Record<string, unknown>`),
 * então o shape da config do host não importa aqui.
 *
 * Por que não `unknown` nem `never`:
 * - `Plugin<unknown>`: os hooks são propriedades-função
 *   (`setup: (ctx: PluginContext<TConfig>) => ...`), contravariantes sob
 *   `strictFunctionTypes` — o consumidor não conseguiria passar
 *   `Plugin<HostConfig>` para `register`/`registerSync`/`registerPlugin`.
 * - `Plugin<never>`: aceitaria o registro, mas o que sai de `get()`/`getAll()`
 *   não poderia mais ser chamado com `PluginContext<HostConfig>` (o FluxStack
 *   faz `plugin.setup(this.pluginContext)` direto).
 * Só `any` é bivariante nas duas pontas. Centralizado aqui para ser o único
 * ponto do pacote.
 */

import type { FluxStack } from '../types'

// any: apagamento bivariante do TConfig — ver comentário acima
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ErasedPlugin = FluxStack.Plugin<any>
