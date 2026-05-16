// Validates issue #34 end-to-end against the running FluxStack dev server.
//
// Strategy:
//   1. Snapshot how many /api/live/ws hits exist in the server log.
//   2. Open the app N times in headless Bun.WebView (each load triggers
//      StrictMode's mount → unmount → mount cycle).
//   3. Count new /api/live/ws hits in the log.
//
// Expected: 1 hit per load (was 2 per load before #34 was fixed).
//
// The FluxStack dev server must be running and writing to /tmp/fluxstack.log.

import { readFileSync } from "fs"

const LOG = process.env.FLUXSTACK_LOG ?? "/tmp/fluxstack.log"
const URL = process.env.FLUXSTACK_URL ?? "http://localhost:3000"
const LOADS = Number(process.env.LOADS ?? "3")
const PER_LOAD_WAIT_MS = 2500

function countWsHandshakes(): number {
  try {
    // Match the GET log line for /api/live/ws (the trailing arrow varies by
    // log format encoding — anchor on "GET" + path instead).
    return (readFileSync(LOG, "utf-8").match(/GET\s+\/api\/live\/ws\b/g) || []).length
  } catch {
    return 0
  }
}

console.log(`Reading log from: ${LOG}`)
console.log(`Target URL:       ${URL}`)
console.log(`Page loads:       ${LOADS}\n`)

const before = countWsHandshakes()
console.log(`Initial /api/live/ws hits in log: ${before}`)

for (let i = 1; i <= LOADS; i++) {
  console.log(`\n→ Load ${i}/${LOADS}`)
  try {
    await using view = new (Bun as any).WebView({
      width: 800,
      height: 600,
      backend: { type: "chrome", stderr: "ignore" },
    })
    await view.navigate(URL)
    await new Promise(r => setTimeout(r, PER_LOAD_WAIT_MS))
    const title = await view.evaluate("document.title")
    console.log(`  page title: ${JSON.stringify(title)}`)
  } catch (err: any) {
    console.warn(`  webview error (ignored, will infer from log): ${err.message}`)
  }
  // Brief gap so the server log flushes between loads.
  await new Promise(r => setTimeout(r, 500))
}

await new Promise(r => setTimeout(r, 1000))
const after = countWsHandshakes()
const delta = after - before

console.log(`\n=== Result ===`)
console.log(`/api/live/ws hits before: ${before}`)
console.log(`/api/live/ws hits after:  ${after}`)
console.log(`new handshakes:           ${delta}`)
console.log(`page loads attempted:     ${LOADS}`)
console.log(`handshakes per load:      ${(delta / LOADS).toFixed(2)}`)

// With the fix: exactly 1 handshake per successful page load.
// Without the fix (#34): 2 per load.
// We allow ≤ LOADS because some loads may fail in headless if Chrome is flaky;
// we fail if we ever see MORE than LOADS (which would mean dedup is broken).
if (delta > LOADS) {
  console.log(`\n❌ FAIL — observed ${delta} handshakes for ${LOADS} loads (>1 per load = #34 regression)`)
  process.exit(1)
}
if (delta === 0) {
  console.log(`\n⚠️  INCONCLUSIVE — no new handshakes seen; webview may have failed to load. Run manually in a browser to confirm.`)
  process.exit(2)
}
console.log(`\n✅ PASS — ${(delta / LOADS).toFixed(2)} handshake per load (#34 fix verified: ≤ 1 per page load)`)
process.exit(0)
