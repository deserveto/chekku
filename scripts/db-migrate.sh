#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CLIENT_ENV_FILE="${CHEKKU_CLIENT_ENV:-$ROOT/client/.env.local}"

if [[ ! -f "$CLIENT_ENV_FILE" ]]; then
  echo "Missing $CLIENT_ENV_FILE. Run npm run setup first." >&2
  exit 1
fi

read_env_value() {
  node - "$CLIENT_ENV_FILE" "$1" <<'NODE'
const { readFileSync } = require('node:fs');
const { parse } = require('dotenv');
const [path, name] = process.argv.slice(2);
process.stdout.write(parse(readFileSync(path, 'utf8'))[name] ?? '');
NODE
}

AUTH_DATABASE_URL="$(read_env_value AUTH_DATABASE_URL)"
if [[ -z "$AUTH_DATABASE_URL" ]]; then
  echo "AUTH_DATABASE_URL is empty in $CLIENT_ENV_FILE. Run npm run setup first." >&2
  exit 1
fi

export AUTH_DATABASE_URL
export BETTER_AUTH_SECRET="$(read_env_value BETTER_AUTH_SECRET)"
export BETTER_AUTH_URL="$(read_env_value BETTER_AUTH_URL)"

cd "$ROOT/client"
if ! npx -y @better-auth/cli migrate; then
  echo "Better Auth migration failed. Confirm Postgres is running and AUTH_DATABASE_URL is reachable." >&2
  exit 1
fi

echo "Better Auth schema applied to chekku_auth."
