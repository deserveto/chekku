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

# shellcheck disable=SC1091
source "$ROOT/scripts/storage-env.sh"

if ! docker compose --env-file storage/.env.local config --quiet >/dev/null 2>&1; then
  echo "Garage Compose configuration is invalid. Check compose.yaml and generated Garage configuration." >&2
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
  local command_pid command_status output_file timed_out_file watchdog_pid
  shift
  output_file="$(mktemp "${TMPDIR:-/tmp}/chekku-health-output.XXXXXX")"
  timed_out_file="${output_file}.timeout"

  set -m
  "$@" >"$output_file" 2>/dev/null &
  command_pid=$!
  (
    sleep "$timeout_seconds"
    : >"$timed_out_file"
    kill -TERM -- "-$command_pid" 2>/dev/null || true
    sleep 0.25
    kill -KILL -- "-$command_pid" 2>/dev/null || true
  ) &
  watchdog_pid=$!

  set +e
  wait "$command_pid" 2>/dev/null
  command_status=$?
  set -e
  if [[ ! -f "$timed_out_file" ]]; then
    kill -TERM -- "-$watchdog_pid" 2>/dev/null || true
  fi
  wait "$watchdog_pid" 2>/dev/null || true
  set +m

  cat "$output_file"
  rm -f "$output_file"
  if [[ -f "$timed_out_file" ]]; then
    rm -f "$timed_out_file"
    return 124
  fi
  return "$command_status"
}

docker_health_timeout() {
  echo "Docker health command timed out before Garage became ready. Check Docker responsiveness." >&2
  exit 1
}

garage_port_conflicts() {
  node - ${CHEKKU_GARAGE_PORTS:-3900} <<'NODE'
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

set +e
service_id="$(run_with_timeout "$ready_timeout_seconds" docker compose --env-file storage/.env.local ps -q garage)"
health_status=$?
set -e
if [[ "$health_status" == 124 ]]; then docker_health_timeout; fi
if [[ "$health_status" != 0 ]]; then
  echo "Could not query Garage service status. Check Docker responsiveness." >&2
  exit 1
fi
if [[ -z "$service_id" ]]; then
  conflicts="$(garage_port_conflicts)"
  if [[ -n "$conflicts" ]]; then
    echo "Garage port conflict: ${conflicts// /, } (required: 3900). Stop conflicting service or change its port." >&2
    exit 1
  fi
fi

if [[ "$GARAGE_CONFIG_CHANGED" == 1 ]]; then
  start_args=(up -d --force-recreate garage)
else
  start_args=(up -d garage)
fi

if ! docker compose --env-file storage/.env.local "${start_args[@]}"; then
  conflicts="$(garage_port_conflicts)"
  if [[ -n "$conflicts" ]]; then
    echo "Garage Compose failed because required port ${conflicts// /, } is occupied (required: 3900)." >&2
  else
    echo "Garage Compose startup failed. Review Docker output above for service details." >&2
  fi
  exit 1
fi

ready=false
ready_deadline=$((SECONDS + ready_timeout_seconds))
while ((SECONDS < ready_deadline)); do
  remaining_seconds=$((ready_deadline - SECONDS))
  if ((remaining_seconds <= 0)); then break; fi
  set +e
  service_id="$(run_with_timeout "$remaining_seconds" docker compose --env-file storage/.env.local ps -q garage)"
  health_status=$?
  set -e
  if [[ "$health_status" == 124 ]]; then docker_health_timeout; fi

  health_status_value=''
  if [[ -n "$service_id" ]]; then
    remaining_seconds=$((ready_deadline - SECONDS))
    if ((remaining_seconds <= 0)); then break; fi
    set +e
    health_status_value="$(run_with_timeout "$remaining_seconds" docker inspect --format '{{.State.Health.Status}}' "$service_id")"
    health_status=$?
    set -e
    if [[ "$health_status" == 124 ]]; then docker_health_timeout; fi
  fi
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
  echo "Garage did not become healthy within $ready_timeout_seconds $duration_unit." >&2
  exit 1
fi

printf 'Garage ready\n  endpoint: %s\n  region: %s\n  bucket: %s\n' \
  "$GARAGE_ENDPOINT" "$GARAGE_REGION" "$GARAGE_BUCKET"

garage_app_cleanup='for garage_name in ${!GARAGE_@}; do case "$garage_name" in GARAGE_ENDPOINT|GARAGE_REGION|GARAGE_BUCKET|GARAGE_ACCESS_KEY_ID|GARAGE_SECRET_ACCESS_KEY) ;; *) unset "$garage_name" ;; esac; done'

if [[ "${CHEKKU_NO_TMUX:-0}" != 1 ]] && command -v tmux >/dev/null 2>&1; then
  root_hash="$(node - "$ROOT" <<'NODE'
const { createHash } = require('node:crypto');
process.stdout.write(createHash('sha256').update(process.argv[2]).digest('hex').slice(0, 12));
NODE
)"
  session_name="chekku-dev-$root_hash"
  if ! tmux has-session -t "$session_name" 2>/dev/null; then
    if ! tmux new-session -d -s "$session_name" -c "$ROOT" "source scripts/storage-env.sh && $garage_app_cleanup && exec npm run dev:agent"; then
      echo "Could not create tmux session '$session_name'." >&2
      exit 1
    fi
    if ! tmux split-window -h -t "$session_name" -c "$ROOT" "source scripts/storage-env.sh && $garage_app_cleanup && exec npm run dev:client" ||
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

eval "$garage_app_cleanup"
set -m
npm run dev:agent &
AGENT_PID=$!
npm run dev:client &
CLIENT_PID=$!

set +e
wait -n "$AGENT_PID" "$CLIENT_PID"
status=$?
set -e
exit "$status"
