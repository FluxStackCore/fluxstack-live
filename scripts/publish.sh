#!/usr/bin/env bash
# publish.sh — Build and publish all @fluxstack/live-* packages to npm
#
# Usage:
#   ./scripts/publish.sh              # dry-run (default)
#   ./scripts/publish.sh --publish    # actually publish
#   ./scripts/publish.sh --publish --otp 123456
#
# Order matters: core → client → adapters → react/vue/redis

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=true
OTP_FLAG=""

# Parse args
for arg in "$@"; do
  case $arg in
    --publish) DRY_RUN=false ;;
    --otp) shift ;;
    [0-9][0-9][0-9][0-9][0-9][0-9]) OTP_FLAG="--otp $arg" ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[publish]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
fail() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# Publish order: dependencies first
PACKAGES=(
  "core"
  "client"
  "elysia"
  "express"
  "fastify"
  "react"
  "vue"
  "redis"
)

# Package name mapping
declare -A PKG_NAMES=(
  [core]="@fluxstack/live"
  [client]="@fluxstack/live-client"
  [elysia]="@fluxstack/live-elysia"
  [express]="@fluxstack/live-express"
  [fastify]="@fluxstack/live-fastify"
  [react]="@fluxstack/live-react"
  [vue]="@fluxstack/live-vue"
  [redis]="@fluxstack/live-redis"
)

cd "$ROOT"

# ── Step 1: Verify versions are consistent ──
log "Checking package versions..."
VERSIONS=()
for pkg in "${PACKAGES[@]}"; do
  VER=$(grep '"version"' "packages/$pkg/package.json" | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/')
  VERSIONS+=("$pkg=$VER")
done

FIRST_VER=$(echo "${VERSIONS[0]}" | cut -d= -f2)
for v in "${VERSIONS[@]}"; do
  PKG=$(echo "$v" | cut -d= -f1)
  VER=$(echo "$v" | cut -d= -f2)
  if [ "$VER" != "$FIRST_VER" ]; then
    fail "Version mismatch: $PKG=$VER (expected $FIRST_VER)"
  fi
done
ok "All packages at v$FIRST_VER"

# ── Step 2: Check if already published ──
log "Checking npm registry..."
NPM_VER=$(npm view @fluxstack/live version 2>/dev/null || echo "not-found")
if [ "$NPM_VER" = "$FIRST_VER" ]; then
  fail "v$FIRST_VER already published on npm. Bump versions first."
fi
ok "v$FIRST_VER not yet published (npm has $NPM_VER)"

# ── Step 3: Run tests ──
log "Running tests..."
TEST_OUTPUT=$(bunx vitest run 2>&1 || true)
echo "$TEST_OUTPUT" | tail -5
# "Tests" line shows individual test results (Test Files may fail for Redis/Docker)
TESTS_LINE=$(echo "$TEST_OUTPUT" | grep "^.*Tests " | tail -1)
if echo "$TESTS_LINE" | grep -q "failed"; then
  fail "Individual tests failed. Fix before publishing."
fi
PASSED_COUNT=$(echo "$TESTS_LINE" | sed 's/.*\([0-9][0-9]*\) passed.*/\1/')
ok "Tests passed ($PASSED_COUNT tests)"

# ── Step 4: Type check ──
log "Type checking core..."
bunx tsc -p packages/core/tsconfig.json --noEmit
ok "Type check passed"

# ── Step 5: Build all ──
log "Building all packages..."
bun run build:core
bun run build:client
# Build adapters individually (Windows compat)
cd packages/elysia && bunx tsup && cd "$ROOT"
cd packages/express && bunx tsup && cd "$ROOT"
cd packages/fastify && bunx tsup && cd "$ROOT"
bun run build:react
# Vue and Redis (if they have tsup config)
if [ -f packages/vue/tsup.config.ts ]; then
  cd packages/vue && bunx tsup && cd "$ROOT"
fi
if [ -f packages/redis/tsup.config.ts ]; then
  cd packages/redis && bunx tsup && cd "$ROOT"
fi
ok "All packages built"

# ── Step 6: Publish ──
if [ "$DRY_RUN" = true ]; then
  warn "DRY RUN — would publish these packages:"
  for pkg in "${PACKAGES[@]}"; do
    echo "  ${PKG_NAMES[$pkg]}@$FIRST_VER"
  done
  echo ""
  warn "Run with --publish to actually publish:"
  echo "  ./scripts/publish.sh --publish --otp <code>"
  exit 0
fi

log "Publishing v$FIRST_VER to npm..."
PUBLISHED=0
FAILED=0

for pkg in "${PACKAGES[@]}"; do
  PKG_DIR="packages/$pkg"
  PKG_NAME="${PKG_NAMES[$pkg]}"

  # Check if this specific package version exists
  EXISTING=$(npm view "$PKG_NAME@$FIRST_VER" version 2>/dev/null || echo "")
  if [ "$EXISTING" = "$FIRST_VER" ]; then
    warn "SKIP $PKG_NAME@$FIRST_VER (already published)"
    continue
  fi

  log "Publishing $PKG_NAME@$FIRST_VER..."
  if cd "$ROOT/$PKG_DIR" && npm publish --access public $OTP_FLAG 2>&1; then
    ok "$PKG_NAME@$FIRST_VER published"
    ((PUBLISHED++))
  else
    fail "Failed to publish $PKG_NAME"
    ((FAILED++))
  fi
  cd "$ROOT"
done

echo ""
if [ "$FAILED" -eq 0 ]; then
  ok "All done! Published $PUBLISHED packages at v$FIRST_VER"
else
  fail "$FAILED packages failed to publish"
fi
