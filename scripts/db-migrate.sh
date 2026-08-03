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

MIGRATE_LOG="$(mktemp)"
chmod 600 "$MIGRATE_LOG"
cd "$ROOT/client"

BACKUP_DIR="$(mktemp -d)"
restore_files() {
  if [[ -d "$BACKUP_DIR" ]]; then
    while IFS= read -r -d '' backup; do
      rel="${backup#"$BACKUP_DIR"/}"
      cp "$backup" "$ROOT/$rel"
    done < <(find "$BACKUP_DIR" -type f -print0 2>/dev/null)
    rm -rf "$BACKUP_DIR"
  fi
  rm -f "$MIGRATE_LOG"
}
trap restore_files EXIT

while IFS= read -r -d '' file; do
  if grep -q "^import 'server-only';" "$file" 2>/dev/null; then
    rel="${file#"$ROOT"/}"
    mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
    cp "$file" "$BACKUP_DIR/$rel"
    sed -i "/^import 'server-only';$/d" "$file"
  fi
done < <(find "$ROOT/client/src" -name '*.ts' ! -name '*.test.ts' -print0 2>/dev/null)

if ! echo y | npx -y @better-auth/cli migrate --config src/lib/auth.ts >"$MIGRATE_LOG" 2>&1; then
  echo "Better Auth migration failed. Confirm Postgres is running and AUTH_DATABASE_URL is reachable." >&2
  exit 1
fi

echo "Better Auth schema applied to chekku_auth."
