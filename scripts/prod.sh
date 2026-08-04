#!/usr/bin/env bash
# Production launcher: builds and runs the full Chekku stack in containers.
#
#   scripts/prod.sh           build images, bring everything up, wait healthy
#   scripts/prod.sh build     build the agent and client images only
#   scripts/prod.sh up        bring the stack up (assumes images are built)
#   scripts/prod.sh down      stop and remove containers (keeps volumes)
#
# Development stays unchanged: scripts/dev.sh runs the agent and client as host
# processes and only starts garage, searxng, and postgres. The agent and client
# services in compose.yaml are gated behind the `prod` profile, so this script
# is the only path that activates them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

ACTION="${1:-up}"
case "$ACTION" in
  build|up|down) ;;
  *)
    echo "Usage: $0 [build|up|down]" >&2
    exit 1
    ;;
esac

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is required." >&2
  exit 1
fi

# ----- Required local files -------------------------------------------------
# Production secrets are not invented here. The operator must have run
# scripts/setup-env.sh (which generates storage/.env.local and searxng/.env.local)
# and filled agent/.env + client/.env.local with production values.
AGENT_ENV_FILE="$ROOT/agent/.env"
CLIENT_ENV_FILE="$ROOT/client/.env.local"
STORAGE_ENV_FILE="$ROOT/storage/.env.local"
SEARXNG_ENV_FILE="$ROOT/searxng/.env.local"

for required_file in "$STORAGE_ENV_FILE" "$SEARXNG_ENV_FILE" "$AGENT_ENV_FILE" "$CLIENT_ENV_FILE"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Missing $(basename "$required_file"). Run scripts/setup-env.sh first and fill production values." >&2
    exit 1
  fi
done

# ----- Load every value compose needs into the shell for interpolation -------
# These files are dotenv, not bash scripts: values like `LLM_DISPLAY_NAME=Rafiqspace LLM`
# or `RESEND_FROM_EMAIL=Chekku <onboarding@resend.dev>` cannot be `source`d by bash.
# Parse them with node+dotenv (the same library scripts/setup-env.sh uses) and emit
# bash-safe `export KEY='value'` lines. Merge order is [storage, searxng, client,
# agent]; the first non-empty value for a key wins, so storage's real GARAGE_* and
# POSTGRES_PASSWORD beat agent's empty placeholders, while agent's user-set
# SEARXNG_API_KEY beats searxng's empty value. SEARXNG_SECRET and SEARXNG_CONFIG_HASH
# are kept because the searxng container needs them; service-only secrets never reach
# agent/client because their compose `environment:` blocks do not declare them.
eval "$(node - "$STORAGE_ENV_FILE" "$SEARXNG_ENV_FILE" "$CLIENT_ENV_FILE" "$AGENT_ENV_FILE" <<'NODE'
const { readFileSync } = require('node:fs');
const { parse } = require('dotenv');
const files = process.argv.slice(2);
const merged = {};
for (const file of files) {
  let values = {};
  try { values = parse(readFileSync(file, 'utf8')); } catch { values = {}; }
  for (const [name, value] of Object.entries(values)) {
    if (value === '' || name in merged) continue;
    merged[name] = value;
  }
}
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
for (const [name, value] of Object.entries(merged)) {
  process.stdout.write(`export ${name}=${shellQuote(value)}\n`);
}
NODE
)"

# ----- Validate required application values before touching Docker ----------
require_env() {
  local name="$1" where="$2"
  if [[ -z "${!name:-}" ]]; then
    echo "$name is empty in $where. Production will not start without it." >&2
    exit 1
  fi
}

require_env POSTGRES_PASSWORD "$STORAGE_ENV_FILE"
require_env GARAGE_ACCESS_KEY_ID "$STORAGE_ENV_FILE"
require_env GARAGE_SECRET_ACCESS_KEY "$STORAGE_ENV_FILE"
require_env LLM_BASE_URL "$AGENT_ENV_FILE"
require_env LLM_API_KEY "$AGENT_ENV_FILE"
require_env LLM_DEFAULT_MODEL "$AGENT_ENV_FILE"

# ----- Compose invocation ---------------------------------------------------
# `--env-file storage/.env.local` is passed for parity with scripts/dev.sh and
# keeps the infra services' ${VAR:?} interpolation resolving. Application values
# arrive via the shell environment sourced above; compose reads them from there.
COMPOSE=(docker compose --env-file storage/.env.local --profile prod)

if ! "${COMPOSE[@]}" config --quiet >/dev/null 2>&1; then
  echo "Production Compose configuration is invalid. Check compose.yaml and the env files." >&2
  exit 1
fi

if [[ "$ACTION" == down ]]; then
  "${COMPOSE[@]}" down
  echo "Production stack stopped."
  exit 0
fi

if [[ "$ACTION" == build ]]; then
  echo "Building agent and client images..."
  "${COMPOSE[@]}" build agent client
  echo "Images built."
  exit 0
fi

# ACTION == up: build (if needed) and bring the whole stack up.
echo "Starting production stack (build if needed)..."
"${COMPOSE[@]}" up -d --build

# ----- Bounded readiness polling -------------------------------------------
normalize_decimal() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  while [[ ${#value} -gt 1 && "${value:0:1}" == 0 ]]; do value="${value:1}"; done
  printf '%s' "$value"
}

ready_timeout_seconds="$(normalize_decimal "${CHEKKU_READY_TIMEOUT_SECONDS:-60}")" || {
  echo "CHEKKU_READY_TIMEOUT_SECONDS must be an integer from 1 to 600." >&2
  exit 1
}
if [[ "$ready_timeout_seconds" == 0 ]] || ((${#ready_timeout_seconds} > 3)) ||
  ((10#$ready_timeout_seconds > 600)); then
  echo "CHEKKU_READY_TIMEOUT_SECONDS must be an integer from 1 to 600." >&2
  exit 1
fi
ready_timeout_seconds=$((10#$ready_timeout_seconds))

run_with_timeout() {
  local timeout_seconds="$1" command_pid command_status output_file deadline_microseconds now timed_out
  shift
  output_file="$(mktemp "${TMPDIR:-/tmp}/chekku-prod-output.XXXXXX")"
  set -m
  "$@" >"$output_file" 2>/dev/null &
  command_pid=$!
  now="${EPOCHREALTIME/./}"
  deadline_microseconds=$((10#$now + timeout_seconds * 1000000))
  timed_out=false
  while kill -0 "$command_pid" 2>/dev/null; do
    now="${EPOCHREALTIME/./}"
    if ((10#$now >= deadline_microseconds)); then
      timed_out=true
      kill -TERM -- "-$command_pid" 2>/dev/null || true
      sleep 0.25
      kill -KILL -- "-$command_pid" 2>/dev/null || true
      break
    fi
    sleep 0.05
  done
  set +e
  wait "$command_pid" 2>/dev/null
  command_status=$?
  set -e
  set +m
  cat "$output_file"
  rm -f "$output_file"
  if [[ "$timed_out" == true ]]; then return 124; fi
  return "$command_status"
}

wait_healthy() {
  local service="$1" display="$2"
  local deadline=$((SECONDS + ready_timeout_seconds)) service_id health_status
  while (( SECONDS < deadline )); do
    service_id="$(run_with_timeout "$((deadline - SECONDS < 1 ? 1 : deadline - SECONDS))" "${COMPOSE[@]}" ps -q "$service")" || true
    service_id="${service_id//$'\r'/}"
    if [[ -n "$service_id" ]]; then
      health_status="$(run_with_timeout 5 docker inspect --format '{{.State.Health.Status}}' "$service_id")" || true
      health_status="${health_status//$'\r'/}"
      if [[ "$health_status" == healthy ]]; then
        printf '%s ready\n' "$display"
        return 0
      fi
    fi
    sleep 1
  done
  echo "$display did not become healthy within $ready_timeout_seconds seconds." >&2
  exit 1
}

wait_healthy garage Garage
wait_healthy searxng SearXNG
wait_healthy postgres Postgres
wait_healthy agent Agent
wait_healthy client Client

# ----- Summary (no secret values) ------------------------------------------
printf '\nProduction stack is running.\n'
printf '  Studio:       http://localhost:3000\n'
printf '  Agent health: reachable from the client container at http://agent:4111/healthz\n'
printf '  Reports:      http://localhost:3000/reports\n'
printf '\nStop with: scripts/prod.sh down\n'
