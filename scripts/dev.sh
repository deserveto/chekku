#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

if [[ ! -f "$ROOT/agent/.env" ]]; then
  rm -f "$ROOT/agent/.env.development"
  echo "Missing agent/.env. Create it with: cp agent/.env.example agent/.env" >&2
  exit 1
fi

node - "$ROOT/agent/.env" <<'NODE'
const { readFileSync } = require('node:fs');
const { parse } = require('dotenv');

const values = parse(readFileSync(process.argv[2]));
for (const name of ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_DEFAULT_MODEL']) {
  if (!values[name]?.trim()) {
    process.stderr.write(`${name} is missing or empty in agent/.env. Set it before running scripts/dev.sh.\n`);
    process.exitCode = 1;
  }
}
NODE

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is required." >&2
  exit 1
fi

STORAGE_ENV_FILE="$ROOT/storage/.env.local"
SEARXNG_ENV_FILE="$ROOT/searxng/.env.local"
GARAGE_CONFIG_FILE="$ROOT/storage/.garage/garage.toml"
GARAGE_APPLIED_HASH_FILE="$ROOT/storage/.garage/.applied-hash"

for required_file in "$STORAGE_ENV_FILE" "$SEARXNG_ENV_FILE" "$GARAGE_CONFIG_FILE"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Missing $(basename "$required_file"). Run scripts/setup-env.sh first." >&2
    exit 1
  fi
done

set -a
# shellcheck disable=SC1090
source "$STORAGE_ENV_FILE"
# shellcheck disable=SC1090
source "$SEARXNG_ENV_FILE"
set +a

TOML_HASH="$(sha256sum "$GARAGE_CONFIG_FILE" | cut -d' ' -f1)"
APPLIED_HASH=""
if [[ -f "$GARAGE_APPLIED_HASH_FILE" ]]; then
  APPLIED_HASH="$(cat "$GARAGE_APPLIED_HASH_FILE")"
fi
export GARAGE_CONFIG_CHANGED=0
if [[ "$TOML_HASH" != "$APPLIED_HASH" ]]; then
  export GARAGE_CONFIG_CHANGED=1
fi

if ! docker compose --env-file storage/.env.local config --quiet >/dev/null 2>&1; then
  echo "Local services Compose configuration is invalid. Check compose.yaml and generated service configuration." >&2
  exit 1
fi

normalize_decimal() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  while [[ ${#value} -gt 1 && "${value:0:1}" == 0 ]]; do value="${value:1}"; done
  printf '%s' "$value"
}

ready_timeout_seconds="$(normalize_decimal "${CHEKKU_READY_TIMEOUT_SECONDS:-30}")" || {
  echo "CHEKKU_READY_TIMEOUT_SECONDS must be an integer from 1 to 300." >&2
  exit 1
}
if [[ "$ready_timeout_seconds" == 0 ]] || ((${#ready_timeout_seconds} > 3)) ||
  ((10#$ready_timeout_seconds > 300)); then
  echo "CHEKKU_READY_TIMEOUT_SECONDS must be an integer from 1 to 300." >&2
  exit 1
fi
ready_timeout_seconds=$((10#$ready_timeout_seconds))

ready_interval_seconds="$(normalize_decimal "${CHEKKU_READY_INTERVAL_SECONDS:-1}")" || {
  echo "CHEKKU_READY_INTERVAL_SECONDS must be a positive integer." >&2
  exit 1
}
if [[ "$ready_interval_seconds" == 0 ]]; then
  echo "CHEKKU_READY_INTERVAL_SECONDS must be a positive integer." >&2
  exit 1
fi

if ((${#ready_interval_seconds} > 1)); then
  ready_interval_seconds=5
else
  ready_interval_seconds=$((10#$ready_interval_seconds))
  if ((ready_interval_seconds > 5)); then ready_interval_seconds=5; fi
fi

run_with_timeout() {
  local timeout_seconds="$1"
  local command_pid command_status output_file deadline_microseconds now timed_out
  shift
  output_file="$(mktemp "${TMPDIR:-/tmp}/chekku-health-output.XXXXXX")"

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

docker_health_timeout() {
  local display_name="$1"
  echo "Docker health command timed out before $display_name became ready. Check Docker responsiveness." >&2
  exit 1
}

service_port_conflicts() {
  node - $1 <<'NODE'
const net = require('node:net');

const ports = process.argv.slice(2).map(Number);
const check = (port) => new Promise((resolve) => {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => {
    socket.destroy();
    resolve(port);
  });
  socket.once('error', () => {
    const server = net.createServer();
    server.once('error', () => resolve(port));
    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      server.close(() => resolve(null));
    });
  });
  socket.setTimeout(250, () => socket.destroy(new Error('timeout')));
});

Promise.all(ports.map(check)).then((results) => {
  process.stdout.write(results.filter(Boolean).join(' '));
});
NODE
}

ensure_service_ready() {
  local service="$1"
  local display_name="$2"
  local test_ports="$3"
  local required_port service_id health_status conflicts ready ready_deadline first_ready_poll
  local remaining_seconds health_status_value sleep_seconds duration_unit
  local -a start_args

  case "$service" in
    garage) required_port=3900 ;;
    searxng) required_port=8888 ;;
    *) echo "Unsupported development service." >&2; exit 1 ;;
  esac

  set +e
  service_id="$(run_with_timeout "$ready_timeout_seconds" docker compose --env-file storage/.env.local ps -q "$service")"
  health_status=$?
  set -e
  if [[ "$health_status" == 124 ]]; then docker_health_timeout "$display_name"; fi
  if [[ "$health_status" != 0 ]]; then
    echo "Could not query $display_name service status. Check Docker responsiveness." >&2
    exit 1
  fi
  if [[ -z "$service_id" ]]; then
    conflicts="$(service_port_conflicts "$test_ports")"
    if [[ -n "$conflicts" ]]; then
      echo "$display_name port conflict: ${conflicts// /, } (required: $required_port). Stop conflicting service or change its port." >&2
      exit 1
    fi
  fi

  if [[ "$service" == garage && "$GARAGE_CONFIG_CHANGED" == 1 ]]; then
    start_args=(up -d --force-recreate "$service")
  else
    start_args=(up -d "$service")
  fi

  if ! docker compose --env-file storage/.env.local "${start_args[@]}"; then
    conflicts="$(service_port_conflicts "$test_ports")"
    if [[ -n "$conflicts" ]]; then
      echo "$display_name Compose failed because required port ${conflicts// /, } is occupied (required: $required_port)." >&2
    else
      echo "$display_name Compose startup failed. Review Docker output above for service details." >&2
    fi
    exit 1
  fi

  ready=false
  ready_deadline=$((SECONDS + ready_timeout_seconds))
  first_ready_poll=true
  while [[ "$first_ready_poll" == true ]] || ((SECONDS < ready_deadline)); do
    remaining_seconds=$((ready_deadline - SECONDS))
    if ((remaining_seconds <= 0)); then
      if [[ "$first_ready_poll" == true ]]; then remaining_seconds=1; else break; fi
    fi
    set +e
    service_id="$(run_with_timeout "$remaining_seconds" docker compose --env-file storage/.env.local ps -q "$service")"
    health_status=$?
    set -e
    if [[ "$health_status" == 124 ]]; then docker_health_timeout "$display_name"; fi

    health_status_value=''
    if [[ -n "$service_id" ]]; then
      remaining_seconds=$((ready_deadline - SECONDS))
      if ((remaining_seconds <= 0)); then
        if [[ "$first_ready_poll" == true ]]; then remaining_seconds=1; else break; fi
      fi
      set +e
      health_status_value="$(run_with_timeout "$remaining_seconds" docker inspect --format '{{.State.Health.Status}}' "$service_id")"
      health_status=$?
      set -e
      if [[ "$health_status" == 124 ]]; then docker_health_timeout "$display_name"; fi
    fi
    first_ready_poll=false
    if [[ "$health_status_value" == healthy ]]; then
      ready=true
      break
    fi

    remaining_seconds=$((ready_deadline - SECONDS))
    if ((remaining_seconds <= 0)); then break; fi
    sleep_seconds="$ready_interval_seconds"
    if ((sleep_seconds > remaining_seconds)); then sleep_seconds="$remaining_seconds"; fi
    sleep "$sleep_seconds"
  done

  if [[ "$ready" != true ]]; then
    duration_unit=seconds
    if [[ "$ready_timeout_seconds" == 1 ]]; then duration_unit=second; fi
    echo "$display_name did not become healthy within $ready_timeout_seconds $duration_unit." >&2
    exit 1
  fi
}

ensure_service_ready garage Garage "${CHEKKU_GARAGE_PORTS:-3900}"

if [[ "$GARAGE_CONFIG_CHANGED" == 1 ]]; then
  printf '%s' "$TOML_HASH" > "$GARAGE_APPLIED_HASH_FILE"
  chmod 600 "$GARAGE_APPLIED_HASH_FILE"
fi

printf 'Garage ready\n  endpoint: %s\n  region: %s\n  bucket: %s\n' \
  "$GARAGE_ENDPOINT" "$GARAGE_REGION" "$GARAGE_BUCKET"

ensure_service_ready searxng SearXNG "${CHEKKU_SEARXNG_PORTS:-8888}"

printf 'SearXNG ready\n  base URL: %s\n' "$SEARXNG_BASE_URL"

garage_app_cleanup='for garage_name in ${!GARAGE_@}; do case "$garage_name" in GARAGE_ENDPOINT|GARAGE_REGION|GARAGE_BUCKET|GARAGE_ACCESS_KEY_ID|GARAGE_SECRET_ACCESS_KEY) ;; *) unset "$garage_name" ;; esac; done'
searxng_agent_cleanup='for searxng_name in ${!SEARXNG_@}; do case "$searxng_name" in SEARXNG_BASE_URL|SEARXNG_API_KEY) ;; *) unset "$searxng_name" ;; esac; done'
searxng_client_cleanup='for searxng_name in ${!SEARXNG_@}; do unset "$searxng_name"; done'

if [[ "${CHEKKU_NO_TMUX:-0}" != 1 ]] && command -v tmux >/dev/null 2>&1; then
  root_hash="$(node - "$ROOT" <<'NODE'
const { createHash } = require('node:crypto');
process.stdout.write(createHash('sha256').update(process.argv[2]).digest('hex').slice(0, 12));
NODE
)"
  session_name="chekku-dev-$root_hash"
  if ! tmux has-session -t "$session_name" 2>/dev/null; then
    if ! tmux new-session -d -s "$session_name" -c "$ROOT" "set -a && source storage/.env.local && source searxng/.env.local && set +a && $garage_app_cleanup && $searxng_agent_cleanup && exec npm run dev:agent"; then
      echo "Could not create tmux session '$session_name'." >&2
      exit 1
    fi
    if ! tmux split-window -h -t "$session_name" -c "$ROOT" "set -a && source storage/.env.local && source searxng/.env.local && set +a && $garage_app_cleanup && $searxng_client_cleanup && exec npm run dev:client" ||
      ! tmux select-layout -t "$session_name" even-horizontal; then
      tmux kill-session -t "$session_name" 2>/dev/null || true
      echo "Could not configure tmux session '$session_name'; partial session removed." >&2
      exit 1
    fi
  fi

  if [[ -n "${TMUX:-}" ]]; then
    tmux switch-client -t "$session_name"
  elif [[ -t 0 && -t 1 ]]; then
    exec tmux attach-session -t "$session_name"
  else
    echo "Development session is running. Attach with: tmux attach-session -t $session_name"
  fi
  exit 0
fi

term_grace_seconds="$(normalize_decimal "${CHEKKU_TERM_GRACE_SECONDS:-2}")" || {
  echo "CHEKKU_TERM_GRACE_SECONDS must be an integer from 1 to 30." >&2
  exit 1
}
if [[ "$term_grace_seconds" == 0 ]] || ((${#term_grace_seconds} > 2)) ||
  ((10#$term_grace_seconds > 30)); then
  echo "CHEKKU_TERM_GRACE_SECONDS must be an integer from 1 to 30." >&2
  exit 1
fi
term_grace_seconds=$((10#$term_grace_seconds))

AGENT_PID=''
CLIENT_PID=''

cleanup() {
  trap - INT TERM EXIT
  if [[ -n "$AGENT_PID" ]]; then kill -TERM -- "-$AGENT_PID" 2>/dev/null || true; fi
  if [[ -n "$CLIENT_PID" ]]; then kill -TERM -- "-$CLIENT_PID" 2>/dev/null || true; fi
  local deadline=$((SECONDS + term_grace_seconds))
  while ((SECONDS < deadline)); do
    local running=false
    if [[ -n "$AGENT_PID" ]] && kill -0 -- "-$AGENT_PID" 2>/dev/null; then running=true; fi
    if [[ -n "$CLIENT_PID" ]] && kill -0 -- "-$CLIENT_PID" 2>/dev/null; then running=true; fi
    if [[ "$running" == false ]]; then break; fi
    sleep 0.1
  done
  if [[ -n "$AGENT_PID" ]]; then kill -KILL -- "-$AGENT_PID" 2>/dev/null || true; fi
  if [[ -n "$CLIENT_PID" ]]; then kill -KILL -- "-$CLIENT_PID" 2>/dev/null || true; fi
  if [[ -n "$AGENT_PID" ]]; then wait "$AGENT_PID" 2>/dev/null || true; fi
  if [[ -n "$CLIENT_PID" ]]; then wait "$CLIENT_PID" 2>/dev/null || true; fi
}
trap 'cleanup' INT TERM EXIT

set -m
(
  eval "$garage_app_cleanup"
  eval "$searxng_agent_cleanup"
  exec npm run dev:agent
) &
AGENT_PID=$!
(
  eval "$garage_app_cleanup"
  eval "$searxng_client_cleanup"
  exec npm run dev:client
) &
CLIENT_PID=$!

set +e
wait -n "$AGENT_PID" "$CLIENT_PID"
status=$?
set -e
exit "$status"
