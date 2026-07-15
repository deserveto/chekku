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

garage_port_conflicts() {
  node - ${CHEKKU_GARAGE_PORTS:-3900 3901 3902 3903} <<'NODE'
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

service_id="$(docker compose --env-file storage/.env.local ps -q garage)"
if [[ -z "$service_id" ]]; then
  conflicts="$(garage_port_conflicts)"
  if [[ -n "$conflicts" ]]; then
    echo "Garage port conflict: ${conflicts// /, } (required: 3900-3903). Stop conflicting service or change its ports." >&2
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
    echo "Garage Compose failed because required port(s) ${conflicts// /, } are occupied (required: 3900-3903)." >&2
  else
    echo "Garage Compose startup failed. Review Docker output above for service details." >&2
  fi
  exit 1
fi

ready_timeout_seconds="${CHEKKU_READY_TIMEOUT_SECONDS:-30}"
ready_interval_seconds="${CHEKKU_READY_INTERVAL_SECONDS:-1}"
if [[ ! "$ready_timeout_seconds" =~ ^[1-9][0-9]{0,2}$ ]] || ((10#$ready_timeout_seconds > 300)); then
  echo "CHEKKU_READY_TIMEOUT_SECONDS must be an integer from 1 to 300." >&2
  exit 1
fi
if [[ ! "$ready_interval_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "CHEKKU_READY_INTERVAL_SECONDS must be a positive integer." >&2
  exit 1
fi
if ((${#ready_interval_seconds} > 1)) || ((10#$ready_interval_seconds > 5)); then
  ready_interval_seconds=5
fi

ready=false
ready_deadline=$((SECONDS + ready_timeout_seconds))
while ((SECONDS < ready_deadline)); do
  service_id="$(docker compose --env-file storage/.env.local ps -q garage)"
  if [[ -n "$service_id" ]] && [[ "$(docker inspect --format '{{.State.Health.Status}}' "$service_id" 2>/dev/null || true)" == healthy ]]; then
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

if [[ "${CHEKKU_NO_TMUX:-0}" != 1 ]] && command -v tmux >/dev/null 2>&1; then
  root_hash="$(node - "$ROOT" <<'NODE'
const { createHash } = require('node:crypto');
process.stdout.write(createHash('sha256').update(process.argv[2]).digest('hex').slice(0, 12));
NODE
)"
  session_name="chekku-dev-$root_hash"
  if ! tmux has-session -t "$session_name" 2>/dev/null; then
    if ! tmux new-session -d -s "$session_name" -c "$ROOT" "source scripts/storage-env.sh && exec npm run dev:agent"; then
      echo "Could not create tmux session '$session_name'." >&2
      exit 1
    fi
    if ! tmux split-window -h -t "$session_name" -c "$ROOT" "source scripts/storage-env.sh && exec npm run dev:client" ||
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

AGENT_PID=''
CLIENT_PID=''

cleanup() {
  trap - INT TERM EXIT
  if [[ -n "$AGENT_PID" ]]; then kill -TERM -- "-$AGENT_PID" 2>/dev/null || true; fi
  if [[ -n "$CLIENT_PID" ]]; then kill -TERM -- "-$CLIENT_PID" 2>/dev/null || true; fi
  if [[ -n "$AGENT_PID" ]]; then wait "$AGENT_PID" 2>/dev/null || true; fi
  if [[ -n "$CLIENT_PID" ]]; then wait "$CLIENT_PID" 2>/dev/null || true; fi
}
trap 'cleanup' INT TERM EXIT

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
