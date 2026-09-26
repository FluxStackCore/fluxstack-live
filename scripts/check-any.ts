#!/usr/bin/env bun
// Catraca de `any`: conta usos explícitos de `any` no código-fonte (sem testes)
// de cada pacote e falha se algum pacote passar do teto registrado em
// scripts/any-baseline.json. O teto só desce: rode com --update depois de
// reduzir para travar o ganho.
//
//   bun scripts/check-any.ts            # verifica (CI)
//   bun scripts/check-any.ts --update   # grava a contagem atual como novo teto
//   bun scripts/check-any.ts --list core   # lista ocorrências de um pacote
//
// `unknown` NÃO conta: é o tipo correto para dados de fronteira (rede, JSON)
// desde que validado antes do uso.

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'fs'
import { join, relative } from 'path'

const ROOT = join(import.meta.dir, '..')
const PACKAGES = join(ROOT, 'packages')
const BASELINE = join(import.meta.dir, 'any-baseline.json')

/** `: any`, `as any`, `<any>`, `any[]`, `any>`, `, any` — fora de comentários. */
const ANY_RE = /(?::\s*any\b|\bas\s+any\b|<any>|\bany\[\]|\bany>|,\s*any\b|\(any\))/g

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec|bench)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
  }
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function countPackage(pkg: string): { total: number; hits: string[] } {
  const src = join(PACKAGES, pkg, 'src')
  if (!existsSync(src)) return { total: 0, hits: [] }
  const files: string[] = []
  walk(src, files)
  const hits: string[] = []
  for (const f of files) {
    const lines = stripComments(readFileSync(f, 'utf8')).split('\n')
    lines.forEach((line, i) => {
      const n = line.match(ANY_RE)?.length ?? 0
      for (let k = 0; k < n; k++) hits.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`)
    })
  }
  return { total: hits.length, hits }
}

const pkgs = readdirSync(PACKAGES).filter((p) => statSync(join(PACKAGES, p)).isDirectory()).sort()
const args = process.argv.slice(2)

if (args[0] === '--list') {
  for (const h of countPackage(args[1] ?? 'core').hits) console.log(h)
  process.exit(0)
}

const current: Record<string, number> = {}
for (const p of pkgs) current[p] = countPackage(p).total
const total = Object.values(current).reduce((a, b) => a + b, 0)

if (args[0] === '--update') {
  writeFileSync(BASELINE, JSON.stringify({ total, packages: current }, null, 2) + '\n')
  console.log(`any-baseline atualizado: ${total} no total`)
  for (const p of pkgs) console.log(`  ${p.padEnd(14)} ${current[p]}`)
  process.exit(0)
}

const baseline: { packages: Record<string, number> } = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, 'utf8'))
  : { packages: {} }

let failed = false
for (const p of pkgs) {
  const max = baseline.packages[p] ?? 0
  const now = current[p]
  const mark = now > max ? '✗' : now < max ? '↓' : '✓'
  if (now > max) failed = true
  console.log(`${mark} ${p.padEnd(14)} ${String(now).padStart(4)} / teto ${max}`)
}
console.log(`total: ${total}`)
if (failed) {
  console.error('\nNovos `any` introduzidos. Tipar corretamente (ou `unknown` + validação).')
  process.exit(1)
}
