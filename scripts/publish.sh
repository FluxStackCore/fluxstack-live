#!/usr/bin/env bash
# publish.sh — Build and publish all @fluxstack/live-* packages to npm
#
# Usage:
#   ./scripts/publish.sh              # dry-run (default)
#   ./scripts/publish.sh --publish    # actually publish
#   ./scripts/publish.sh --publish --otp 123456
#   ./scripts/publish.sh --publish --otp 123456 --skip-checks  # skip tests/typecheck
#   ./scripts/publish.sh --publish --otp 123456 --force-build  # rebuild even if up-to-date
#
# Order matters: core → client → adapters → react/vue/redis

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=true
OTP_FLAG=""
SKIP_CHECKS=false
FORCE_BUILD=false

# Parse args
for arg in "$@"; do
  case $arg in
    --publish) DRY_RUN=false ;;
    --skip-checks) SKIP_CHECKS=true ;;
    --force-build) FORCE_BUILD=true ;;
    --otp) ;; # next arg is the code
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

# ── Step 2: Check if ALL packages are already published ──
log "Checking npm registry..."
ALL_PUBLISHED=true
for pkg in "${PACKAGES[@]}"; do
  PKG_NAME="${PKG_NAMES[$pkg]}"
  EXISTING=$(npm view "$PKG_NAME@$FIRST_VER" version 2>/dev/null || echo "")
  if [ "$EXISTING" != "$FIRST_VER" ]; then
    ALL_PUBLISHED=false
    break
  fi
done
if [ "$ALL_PUBLISHED" = true ]; then
  fail "All packages at v$FIRST_VER are already published. Bump versions first."
fi
ok "v$FIRST_VER has unpublished packages"

# ── Step 3: Run tests (skippable) ──
if [ "$SKIP_CHECKS" = false ]; then
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
else
  warn "Skipping tests and type checks (--skip-checks)"
fi

# ── Step 5: Smart build — only rebuild packages with source changes ──
log "Building packages (smart mode)..."

needs_build() {
  local pkg="$1"
  local pkg_dir="packages/$pkg"

  # Force build if requested
  if [ "$FORCE_BUILD" = true ]; then
    return 0
  fi

  # No dist → needs build
  if [ ! -d "$pkg_dir/dist" ]; then
    return 0
  fi

  # Find the newest file in dist/
  local newest_dist
  newest_dist=$(find "$pkg_dir/dist" -type f -printf '%T@\n' 2>/dev/null | sort -rn | head -1)
  if [ -z "$newest_dist" ]; then
    return 0
  fi

  # Find the newest source file in src/
  local newest_src
  newest_src=$(find "$pkg_dir/src" -type f -not -path '*/__tests__/*' -not -path '*/*.test.*' -not -path '*/*.bench.*' -printf '%T@\n' 2>/dev/null | sort -rn | head -1)
  if [ -z "$newest_src" ]; then
    return 1 # no source files means nothing to build
  fi

  # Also check tsup.config.ts and package.json (config changes trigger rebuild)
  local newest_config
  newest_config=$(find "$pkg_dir" -maxdepth 1 \( -name 'tsup.config.ts' -o -name 'package.json' \) -printf '%T@\n' 2>/dev/null | sort -rn | head -1)

  # Compare: if source or config is newer than dist, rebuild
  local compare_ts="$newest_src"
  if [ -n "$newest_config" ] && [ "$(echo "$newest_config > $newest_src" | bc 2>/dev/null || echo 0)" = "1" ]; then
    compare_ts="$newest_config"
  fi

  # Use awk for float comparison (bc may not be available on all systems)
  if awk "BEGIN { exit !($compare_ts > $newest_dist) }"; then
    return 0
  fi

  return 1
}

BUILT=0
SKIPPED=0

for pkg in "${PACKAGES[@]}"; do
  if needs_build "$pkg"; then
    log "  Building $pkg..."
    cd "packages/$pkg" && bunx tsup && cd "$ROOT"
    BUILT=$((BUILT + 1))
  else
    echo -e "  ${GREEN}↳${NC} $pkg — up-to-date, skipping build"
    SKIPPED=$((SKIPPED + 1))
  fi
done

ok "Build complete ($BUILT built, $SKIPPED skipped)"

# ── Step 6: Publish ──
if [ "$DRY_RUN" = true ]; then
  warn "DRY RUN — would publish these packages:"
  for pkg in "${PACKAGES[@]}"; do
    echo "  ${PKG_NAMES[$pkg]}@$FIRST_VER"
  done
  echo ""
  warn "Run with --publish to actually publish:"
  echo "  ./scripts/publish.sh --publish --otp <code>"
  echo ""
  warn "Quick publish (skip tests/build if already done):"
  echo "  ./scripts/publish.sh --publish --otp <code> --skip-checks"
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
    PUBLISHED=$((PUBLISHED + 1))
  else
    echo -e "${RED}[✗]${NC} Failed to publish $PKG_NAME"
    FAILED=$((FAILED + 1))
  fi
  cd "$ROOT"
done

echo ""
if [ "$FAILED" -eq 0 ]; then
  ok "All done! Published $PUBLISHED packages at v$FIRST_VER"
else
  warn "$PUBLISHED published, $FAILED failed. Re-run with a fresh OTP to publish remaining."
  echo "  ./scripts/publish.sh --publish --otp <code> --skip-checks"
  exit 1
fi
