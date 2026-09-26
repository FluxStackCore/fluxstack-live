// Detecta se o Redis de teste está no ar, sem gerar os "Unhandled error event"
// do ioredis. Local: sem Redis os testes PULAM. CI (env CI definida) ou
// REQUIRE_REDIS=1: sem Redis FALHA — lá o serviço é obrigatório e pular
// em silêncio esconderia regressão de cluster.
import { connect } from 'node:net'

export const REDIS_TEST_HOST = '127.0.0.1'
export const REDIS_TEST_PORT = 16379

function probe(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok: boolean) => { socket.destroy(); resolve(ok) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

export async function redisAvailable(host = REDIS_TEST_HOST, port = REDIS_TEST_PORT): Promise<boolean> {
  const up = await probe(host, port)
  if (!up && (process.env.CI || process.env.REQUIRE_REDIS === '1')) {
    throw new Error(
      `Redis de teste indisponível em ${host}:${port} e ele é obrigatório aqui (CI/REQUIRE_REDIS). ` +
      `Local: docker run -d --name fluxstack-test-redis -p ${port}:6379 redis:7-alpine`
    )
  }
  return up
}
