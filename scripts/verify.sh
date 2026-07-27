#!/usr/bin/env bash
#
# Single global verification command for the MVP.
#
# It installs dependencies, lints, type-checks, runs unit and integration tests,
# builds every application and Docker image, starts the Docker test stack, waits
# for all healthchecks, applies migrations, runs the end-to-end suites and finally
# tears the environment down. It exits 0 only if every single step succeeded.
#
# Usage:
#   ./scripts/verify.sh              full run
#   KEEP_STACK=1 ./scripts/verify.sh keep the test stack running afterwards
#   SKIP_DOCKER=1 ./scripts/verify.sh only the host-side checks

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="$ROOT_DIR/.verify-logs"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

TEST_COMPOSE="docker-compose.test.yml"
INTEGRATION_COMPOSE="docker-compose.integration.yml"

INTEGRATION_PG_PORT="${INTEGRATION_PG_PORT:-55432}"
INTEGRATION_REDIS_PORT="${INTEGRATION_REDIS_PORT:-56379}"
TEST_PUBLIC_PORT="${TEST_PUBLIC_PORT:-8081}"
TEST_WEB_PUBLIC_PORT="${TEST_WEB_PUBLIC_PORT:-3901}"

export INTEGRATION_PG_PORT INTEGRATION_REDIS_PORT TEST_PUBLIC_PORT TEST_WEB_PUBLIC_PORT
export APP_BASE_URL="http://localhost:${TEST_PUBLIC_PORT}"
export TEST_WEB_PUBLIC_URL="http://localhost:${TEST_WEB_PUBLIC_PORT}"
export COMPOSE_TEST_FILE="$TEST_COMPOSE"

# --- reporting ---------------------------------------------------------------

STEP_NAMES=()
STEP_RESULTS=()
STEP_CODES=()
STEP_DURATIONS=()
STEP_TESTS=()
FAILED=0

BOLD=$'\033[1m'
RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

log_info() { printf '%s\n' "${BOLD}==> $*${RESET}"; }
log_warn() { printf '%s\n' "${YELLOW}warning: $*${RESET}"; }
log_fail() { printf '%s\n' "${RED}FAILED: $*${RESET}"; }

slugify() { printf '%s' "$1" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-'; }

# Extracts "executed/passed/failed/skipped" counts from a Vitest or Playwright log.
#
# A recursive Vitest run prints one summary per package, and Playwright prints one
# per invocation, so the counts of every summary line are summed. Colour codes are
# stripped first because they sit between the label and the numbers.
extract_counts() {
  local log_file="$1"
  local plain summaries passed=0 failed=0 skipped=0 line n

  [ -f "$log_file" ] || { printf 'n/a|n/a|n/a|n/a'; return; }
  plain="$(sed 's/\x1b\[[0-9;]*m//g' "$log_file")"

  # Vitest: "      Tests  3 failed | 80 passed (83)". The line may be indented, or
  # prefixed with the package name by a recursive run, so it is matched anywhere.
  summaries="$(grep -E 'Tests +[0-9]+ +(passed|failed|skipped)' <<<"$plain" || true)"
  if [ -z "$summaries" ]; then
    # Playwright: "  5 passed (22.6s)" / "  1 failed"
    summaries="$(grep -E '^ +[0-9]+ (passed|failed|skipped|flaky)' <<<"$plain" || true)"
  fi
  if [ -z "$summaries" ]; then
    printf 'n/a|n/a|n/a|n/a'
    return
  fi

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    n="$(sed -n 's/.*[^0-9]\([0-9]\+\) passed.*/\1/p' <<<"$line")"; passed=$((passed + ${n:-0}))
    n="$(sed -n 's/.*[^0-9]\([0-9]\+\) failed.*/\1/p' <<<"$line")"; failed=$((failed + ${n:-0}))
    n="$(sed -n 's/.*[^0-9]\([0-9]\+\) skipped.*/\1/p' <<<"$line")"; skipped=$((skipped + ${n:-0}))
  done <<<"$summaries"

  printf '%s|%s|%s|%s' "$((passed + failed + skipped))" "$passed" "$failed" "$skipped"
}

run_step() {
  local name="$1"
  shift
  local slug log_file start end code
  slug="$(slugify "$name")"
  log_file="$LOG_DIR/${slug}.log"

  log_info "$name"
  start=$SECONDS
  "$@" >"$log_file" 2>&1
  code=$?
  end=$SECONDS

  STEP_NAMES+=("$name")
  STEP_CODES+=("$code")
  STEP_DURATIONS+=("$((end - start))s")
  STEP_TESTS+=("$(extract_counts "$log_file")")

  if [ "$code" -eq 0 ]; then
    STEP_RESULTS+=("PASS")
    printf '    %sok%s (%ss)\n' "$GREEN" "$RESET" "$((end - start))"
  else
    STEP_RESULTS+=("FAIL")
    FAILED=1
    log_fail "$name (exit $code)"
    printf '%s\n' "--- last 60 lines of $log_file ---"
    tail -60 "$log_file"
    printf '%s\n' "--- end of log ---"
  fi
  return "$code"
}

print_summary() {
  printf '\n%s\n' "${BOLD}Verification summary${RESET}"
  printf '%-42s %-6s %-5s %-7s %-7s %-7s %-7s %s\n' \
    "COMMAND" "RESULT" "EXIT" "TESTS" "PASSED" "FAILED" "SKIPPED" "TIME"
  printf '%s\n' "--------------------------------------------------------------------------------------------------"
  local i
  for i in "${!STEP_NAMES[@]}"; do
    IFS='|' read -r total passed failed skipped <<<"${STEP_TESTS[$i]}"
    printf '%-42s %-6s %-5s %-7s %-7s %-7s %-7s %s\n' \
      "${STEP_NAMES[$i]}" "${STEP_RESULTS[$i]}" "${STEP_CODES[$i]}" \
      "$total" "$passed" "$failed" "$skipped" "${STEP_DURATIONS[$i]}"
  done
  printf '\nLogs: %s\n' "$LOG_DIR"
}

cleanup() {
  local exit_code=$?
  if [ "${SKIP_DOCKER:-0}" != "1" ]; then
    if [ "${KEEP_STACK:-0}" = "1" ]; then
      log_warn "KEEP_STACK=1: leaving the test stack running on ${APP_BASE_URL}"
    else
      log_info "Cleaning up the Docker environment"
      docker compose -f "$TEST_COMPOSE" down -v --remove-orphans >"$LOG_DIR/cleanup-test.log" 2>&1
      docker compose -f "$INTEGRATION_COMPOSE" down -v --remove-orphans \
        >"$LOG_DIR/cleanup-integration.log" 2>&1
    fi
  fi
  print_summary
  if [ "$FAILED" -ne 0 ]; then
    printf '\n%s\n' "${RED}${BOLD}VERIFICATION FAILED${RESET}"
    exit 1
  fi
  if [ "$exit_code" -ne 0 ]; then
    exit "$exit_code"
  fi
  printf '\n%s\n' "${GREEN}${BOLD}VERIFICATION PASSED${RESET}"
  exit 0
}
trap cleanup EXIT

# --- helpers ----------------------------------------------------------------

wait_for_http() {
  local url="$1" attempts="${2:-60}" i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "timed out waiting for $url"
  return 1
}

# Fails unless every service with a healthcheck reports "healthy".
wait_for_healthy() {
  local compose_file="$1" attempts="${2:-90}" i status unhealthy
  for ((i = 1; i <= attempts; i++)); do
    unhealthy=""
    while IFS=$'\t' read -r service state health; do
      [ -z "$service" ] && continue
      # The one-shot migration container legitimately exits.
      if [ "$service" = "migrate" ]; then continue; fi
      if [ -n "$health" ] && [ "$health" != "healthy" ]; then
        unhealthy="$unhealthy $service($health)"
      elif [ -z "$health" ] && [ "$state" != "running" ]; then
        unhealthy="$unhealthy $service($state)"
      fi
    done < <(docker compose -f "$compose_file" ps --format '{{.Service}}\t{{.State}}\t{{.Health}}')

    if [ -z "$unhealthy" ]; then
      docker compose -f "$compose_file" ps
      return 0
    fi
    sleep 2
  done
  echo "services never became healthy:$unhealthy"
  docker compose -f "$compose_file" ps
  return 1
}

integration_env() {
  export DATABASE_URL="postgresql://app:integration_password@localhost:${INTEGRATION_PG_PORT}/browser_automation_integration"
  export REDIS_URL="redis://localhost:${INTEGRATION_REDIS_PORT}"
  export JWT_SECRET="integration_test_secret_value"
  export CREDENTIALS_ENC_KEY="0123456789abcdef0123456789abcdef"
  export WORKER_URL="http://worker:5000"
  export LOG_LEVEL="silent"
}

apply_integration_migrations() {
  integration_env
  pnpm --filter @app/database exec prisma migrate deploy
}

run_integration_tests() {
  integration_env
  # Runs every package that defines a test:integration script (api and worker).
  pnpm run test:integration
}

verify_migrations_applied() {
  # The stack's own `migrate` service ran `prisma migrate deploy` plus the seed.
  # Assert the schema really is there, the migration is recorded as finished and
  # the seeded user exists, instead of only printing the state.
  local psql=(docker compose -f "$TEST_COMPOSE" exec -T postgres
    psql -U app -d browser_automation_test -tAc)
  local tables migrations users expected=9

  tables="$("${psql[@]}" \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name <> '_prisma_migrations';" \
    | tr -d '[:space:]')"
  migrations="$("${psql[@]}" \
    "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;" | tr -d '[:space:]')"
  users="$("${psql[@]}" \
    "SELECT count(*) FROM users WHERE email = 'test@example.com';" | tr -d '[:space:]')"

  echo "application tables: ${tables:-0} (expected at least $expected)"
  echo "applied migrations: ${migrations:-0}"
  echo "seeded users: ${users:-0}"

  docker compose -f "$TEST_COMPOSE" exec -T postgres \
    psql -U app -d browser_automation_test -c "\dt"

  if [ "${tables:-0}" -lt "$expected" ]; then
    echo "expected at least $expected application tables, found ${tables:-0}"
    return 1
  fi
  if [ "${migrations:-0}" -lt 1 ]; then
    echo "no finished migration recorded in _prisma_migrations"
    return 1
  fi
  if [ "${users:-0}" -lt 1 ]; then
    echo "the seeded user is missing"
    return 1
  fi
  return 0
}

# --- pipeline ---------------------------------------------------------------

printf '%s\n\n' "${BOLD}Browser Automation MVP - global verification${RESET}"

run_step "install dependencies" pnpm install --frozen-lockfile || exit 1
run_step "prisma client generation" pnpm run db:generate || exit 1
run_step "build workspace packages" pnpm run build || exit 1
run_step "lint" pnpm run lint || exit 1
run_step "type checking" pnpm run typecheck || exit 1
run_step "unit tests" pnpm run test:unit || exit 1

if [ "${SKIP_DOCKER:-0}" = "1" ]; then
  log_warn "SKIP_DOCKER=1: skipping every Docker-based step"
  exit 0
fi

run_step "start integration data stores" \
  docker compose -f "$INTEGRATION_COMPOSE" up -d --wait || exit 1
run_step "integration migrations" apply_integration_migrations || exit 1
run_step "integration tests" run_integration_tests || exit 1
run_step "stop integration data stores" \
  docker compose -f "$INTEGRATION_COMPOSE" down -v || exit 1

run_step "build docker images" docker compose -f "$TEST_COMPOSE" build || exit 1
# A previous run must not leak state into this one.
docker compose -f "$TEST_COMPOSE" down -v --remove-orphans >/dev/null 2>&1
run_step "start docker test environment" docker compose -f "$TEST_COMPOSE" up -d || exit 1
run_step "wait for healthchecks" wait_for_healthy "$TEST_COMPOSE" || exit 1
run_step "verify migrations and seed" verify_migrations_applied || exit 1
run_step "api reachable through the proxy" wait_for_http "${APP_BASE_URL}/ready" || exit 1
run_step "frontend reachable through the proxy" wait_for_http "${APP_BASE_URL}/login" || exit 1
run_step "test-web reachable" wait_for_http "${TEST_WEB_PUBLIC_URL}/health" || exit 1

run_step "install playwright browser" pnpm exec playwright install chromium || exit 1

E2E="pnpm exec playwright test -c e2e/playwright.config.ts"
run_step "e2e stack and healthchecks" $E2E e2e/specs/stack.spec.ts || exit 1
run_step "e2e browser worker and noVNC" $E2E e2e/specs/novnc.spec.ts || exit 1
run_step "e2e session isolation" $E2E e2e/specs/isolation.spec.ts || exit 1
run_step "e2e recorder and overlay" $E2E e2e/specs/recorder.spec.ts || exit 1
run_step "e2e recorder page" $E2E e2e/specs/recorder-ui.spec.ts || exit 1
run_step "e2e on an ipad" $E2E e2e/specs/ipad.spec.ts || exit 1
run_step "e2e variables and secrets" $E2E e2e/specs/credentials.spec.ts || exit 1
run_step "e2e application shell" $E2E e2e/specs/layout.spec.ts || exit 1
run_step "e2e step editor" $E2E e2e/specs/editor.spec.ts || exit 1
run_step "e2e step types" $E2E e2e/specs/step-types.spec.ts || exit 1
run_step "e2e main flow" $E2E e2e/specs/main-flow.spec.ts || exit 1
run_step "e2e stop at first error" $E2E e2e/specs/error-stop.spec.ts || exit 1
run_step "e2e scheduling" $E2E e2e/specs/scheduling.spec.ts || exit 1

run_step "production build of every image" docker compose -f docker-compose.yml build || exit 1
