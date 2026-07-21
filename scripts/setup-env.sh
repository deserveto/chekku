#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required but was not found on PATH." >&2
  exit 1
fi

AGENT_ENV_EXAMPLE="$ROOT/agent/.env.example"
AGENT_ENV_FILE="$ROOT/agent/.env"
CLIENT_ENV_EXAMPLE="$ROOT/client/.env.example"
CLIENT_ENV_FILE="$ROOT/client/.env.local"

for required in "$AGENT_ENV_EXAMPLE" "$CLIENT_ENV_EXAMPLE"; do
  if [[ ! -f "$required" ]]; then
    echo "Required example file is missing: $required" >&2
    exit 1
  fi
done

copy_with_mode() {
  local source="$1"
  local dest="$2"
  local tmp
  tmp="$(mktemp "${dest}.tmp.XXXXXX")"
  cp "$source" "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$dest"
}

if [[ ! -f "$AGENT_ENV_FILE" ]]; then
  copy_with_mode "$AGENT_ENV_EXAMPLE" "$AGENT_ENV_FILE"
fi

if [[ ! -f "$CLIENT_ENV_FILE" ]]; then
  copy_with_mode "$CLIENT_ENV_EXAMPLE" "$CLIENT_ENV_FILE"
fi

sync_env_from_example() {
  local source_env="$1"
  local example_env="$2"
  local tmp
  tmp="$(mktemp "${source_env}.tmp.XXXXXX")"
  chmod 600 "$tmp"
  node - "$source_env" "$example_env" "$tmp" <<'NODE' || { rm -f "$tmp"; echo "sync_env_from_example failed for $source_env" >&2; return 1; }
const { readFileSync, writeFileSync } = require('node:fs');
const { parse } = require('dotenv');
const [sourcePath, examplePath, outputPath] = process.argv.slice(2);

const marker = '# Added by setup-env.sh (synced from .env.example)';
const sourceText = readFileSync(sourcePath, 'utf8');
const exampleText = readFileSync(examplePath, 'utf8');
const sourceValues = parse(sourceText);
const exampleValues = parse(exampleText);
const missing = Object.keys(exampleValues).filter((name) => !(name in sourceValues));
if (missing.length === 0) {
  writeFileSync(outputPath, sourceText, { mode: 0o600 });
  process.exit(0);
}

const eol = sourceText.includes('\r\n') ? '\r\n' : '\n';
const lines = sourceText.split(/\r?\n/);
if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
const hasMarker = lines.some((line) => line.trim() === marker);
const newBlock = hasMarker ? [''] : ['', marker];
for (const name of missing) {
  const value = exampleValues[name] ?? '';
  newBlock.push(`${name}=${value}`);
}
const result = `${lines.join(eol)}${newBlock.join(eol)}${eol}`;
writeFileSync(outputPath, result, { mode: 0o600 });
NODE
  chmod 600 "$tmp"
  if [[ -f "$source_env" ]] && cmp -s "$tmp" "$source_env"; then
    rm "$tmp"
    chmod 600 "$source_env"
  else
    mv -f "$tmp" "$source_env"
    chmod 600 "$source_env"
  fi
}

sync_env_from_example "$AGENT_ENV_FILE" "$AGENT_ENV_EXAMPLE"
sync_env_from_example "$CLIENT_ENV_FILE" "$CLIENT_ENV_EXAMPLE"

STORAGE_ENV_FILE="$ROOT/storage/.env.local"

generate_storage_env() {
  local tmp
  tmp="$(mktemp "${STORAGE_ENV_FILE}.tmp.XXXXXX")"
  chmod 600 "$tmp"
  node - "$STORAGE_ENV_FILE" >"$tmp" <<'NODE'
const { readFileSync } = require('node:fs');
const { parse } = require('dotenv');
const crypto = require('node:crypto');
const [existingPath] = process.argv.slice(2);
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
let existing = {};
try {
  existing = parse(readFileSync(existingPath, 'utf8'));
} catch {
  existing = {};
}
const pick = (name, fallback) => (typeof existing[name] === 'string' && existing[name] !== '' ? existing[name] : fallback);
process.stdout.write([
  `GARAGE_ENDPOINT=${pick('GARAGE_ENDPOINT', 'http://127.0.0.1:3900')}`,
  `GARAGE_REGION=${pick('GARAGE_REGION', 'garage')}`,
  `GARAGE_BUCKET=${pick('GARAGE_BUCKET', 'chekku-objects')}`,
  `GARAGE_ACCESS_KEY_ID=${pick('GARAGE_ACCESS_KEY_ID', `GK${hex(12).toUpperCase()}`)}`,
  `GARAGE_SECRET_ACCESS_KEY=${pick('GARAGE_SECRET_ACCESS_KEY', hex(32))}`,
  `GARAGE_RPC_SECRET=${pick('GARAGE_RPC_SECRET', hex(32))}`,
  `GARAGE_ADMIN_TOKEN=${pick('GARAGE_ADMIN_TOKEN', token())}`,
  `GARAGE_METRICS_TOKEN=${pick('GARAGE_METRICS_TOKEN', token())}`,
  '',
].join('\n'));
NODE
  chmod 600 "$tmp"
  mv -f "$tmp" "$STORAGE_ENV_FILE"
  chmod 600 "$STORAGE_ENV_FILE"
}

storage_env_is_valid() {
  [[ -f "$STORAGE_ENV_FILE" ]] || return 1
  node - "$STORAGE_ENV_FILE" <<'NODE' >/dev/null 2>&1
const { readFileSync } = require('node:fs');
const { parse } = require('dotenv');
const required = [
  'GARAGE_ENDPOINT', 'GARAGE_REGION', 'GARAGE_BUCKET',
  'GARAGE_ACCESS_KEY_ID', 'GARAGE_SECRET_ACCESS_KEY',
  'GARAGE_RPC_SECRET', 'GARAGE_ADMIN_TOKEN', 'GARAGE_METRICS_TOKEN',
];
const values = parse(readFileSync(process.argv[2], 'utf8'));
for (const name of required) {
  const value = values[name];
  if (!value || typeof value !== 'string') process.exit(1);
}
NODE
}

if ! storage_env_is_valid; then
  generate_storage_env
fi

GARAGE_CONFIG_DIR="$ROOT/storage/.garage"
GARAGE_CONFIG_TEMPLATE="$ROOT/storage/garage.toml.template"
GARAGE_CONFIG_FILE="$GARAGE_CONFIG_DIR/garage.toml"

mkdir -p "$GARAGE_CONFIG_DIR"

render_garage_toml() {
  local tmp
  tmp="$(mktemp "${GARAGE_CONFIG_FILE}.tmp.XXXXXX")"
  chmod 600 "$tmp"
  set -a
  # shellcheck disable=SC1090
  source "$STORAGE_ENV_FILE"
  set +a
  node - "$GARAGE_CONFIG_TEMPLATE" "$tmp" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [templatePath, outputPath] = process.argv.slice(2);
const required = ['GARAGE_RPC_SECRET', 'GARAGE_ADMIN_TOKEN', 'GARAGE_METRICS_TOKEN', 'GARAGE_REGION'];
let config = readFileSync(templatePath, 'utf8');
for (const name of required) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in storage/.env.local`);
  config = config.replaceAll(`\${${name}}`, value);
}
writeFileSync(outputPath, config, { mode: 0o600 });
NODE
  chmod 600 "$tmp"
  if [[ -f "$GARAGE_CONFIG_FILE" ]] && cmp -s "$tmp" "$GARAGE_CONFIG_FILE"; then
    rm "$tmp"
    chmod 600 "$GARAGE_CONFIG_FILE"
  else
    mv -f "$tmp" "$GARAGE_CONFIG_FILE"
    chmod 600 "$GARAGE_CONFIG_FILE"
  fi
}

render_garage_toml

SEARXNG_ENV_FILE="$ROOT/searxng/.env.local"
SEARXNG_SETTINGS_FILE="$ROOT/searxng/settings.yml"

generate_searxng_env() {
  local tmp
  tmp="$(mktemp "${SEARXNG_ENV_FILE}.tmp.XXXXXX")"
  chmod 600 "$tmp"
  node - "$SEARXNG_SETTINGS_FILE" "$SEARXNG_ENV_FILE" "$tmp" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const [settingsPath, existingPath, outputPath] = process.argv.slice(2);

const existingValues = (() => {
  try {
    const text = readFileSync(existingPath, 'utf8');
    const lines = text.split('\n');
    if (lines.pop() !== '' || lines.length !== 4) return null;
    const map = {};
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq < 0) return null;
      map[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(map.SEARXNG_SECRET)) return null;
    if (!/^[a-f0-9]{64}$/.test(map.SEARXNG_CONFIG_HASH)) return null;
    if (map.SEARXNG_BASE_URL !== 'http://127.0.0.1:8888') return null;
    if (map.SEARXNG_API_KEY !== '') return null;
    return map;
  } catch {
    return null;
  }
})();

const settings = readFileSync(settingsPath, 'utf8');
const secret = existingValues?.SEARXNG_SECRET ?? randomBytes(32).toString('base64url');
const configHash = createHash('sha256').update(settings).digest('hex');
writeFileSync(outputPath, [
  `SEARXNG_SECRET=${secret}`,
  `SEARXNG_CONFIG_HASH=${configHash}`,
  'SEARXNG_BASE_URL=http://127.0.0.1:8888',
  'SEARXNG_API_KEY=',
  '',
].join('\n'), { mode: 0o600 });
NODE
  chmod 600 "$tmp"
  mv -f "$tmp" "$SEARXNG_ENV_FILE"
  chmod 600 "$SEARXNG_ENV_FILE"
}

generate_searxng_env

AGENT_DEV_ENV_FILE="$ROOT/agent/.env.development"

render_agent_dev_env() {
  if [[ ! -f "$AGENT_ENV_FILE" ]]; then
    rm -f "$AGENT_DEV_ENV_FILE"
    return 0
  fi

  local tmp
  tmp="$(mktemp "${AGENT_DEV_ENV_FILE}.tmp.XXXXXX")"
  chmod 600 "$tmp"

  set -a
  # shellcheck disable=SC1090
  source "$STORAGE_ENV_FILE"
  # shellcheck disable=SC1090
  source "$SEARXNG_ENV_FILE"
  set +a

  node - "$AGENT_ENV_FILE" "$tmp" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const { parse } = require('dotenv');

const [sourcePath, outputPath] = process.argv.slice(2);
const garageKeys = [
  'GARAGE_ENDPOINT', 'GARAGE_REGION', 'GARAGE_BUCKET',
  'GARAGE_ACCESS_KEY_ID', 'GARAGE_SECRET_ACCESS_KEY',
];
const searxngKeys = ['SEARXNG_BASE_URL', 'SEARXNG_API_KEY'];
const serviceSecretNames = [
  'GARAGE_RPC_SECRET', 'GARAGE_ADMIN_TOKEN', 'GARAGE_METRICS_TOKEN',
  'SEARXNG_SECRET', 'SEARXNG_CONFIG_HASH',
];
const leakedValueError = 'Service-only secrets must not appear in agent environment.';
const assignmentPattern = new RegExp(
  '^[^\\S\\r\\n]*(?:export[^\\S\\r\\n]+)?([\\w.-]+)(?:[^\\S\\r\\n]*=[^\\S\\r\\n]*|:[^\\S\\r\\n]+)(.*)$',
);
const invalidAssignmentError = 'Application environment contains an invalid assignment.';

const hasClosingQuote = (value, quote) => {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === quote && value[index - 1] !== '\\') return true;
  }
  return false;
};

const removeAssignments = (prefix) => (input) => {
  const lines = input.match(/[^\r\n]*(?:\r\n|\n|$)/g)?.filter(Boolean) ?? [];
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const content = lines[index].replace(/\r?\n$/, '');
    const assignment = content.match(assignmentPattern);
    if (!assignment || !assignment[1].startsWith(prefix)) {
      kept.push(lines[index]);
      continue;
    }
    const value = assignment[2].trimStart();
    const quote = value[0];
    if (quote === "'" || quote === '"' || quote === '`') {
      let remainder = value.slice(1);
      while (!hasClosingQuote(remainder, quote) && index + 1 < lines.length) {
        index += 1;
        remainder += lines[index];
      }
      if (!hasClosingQuote(remainder, quote)) throw new Error(invalidAssignmentError);
    }
  }
  return kept.join('');
};

const serialize = (name, value) => {
  if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain CR or LF`);
  const candidates = [
    value,
    `'${value}'`,
    `'${value.replaceAll("'", "\\'")}'`,
    `"${value}"`,
    `"${value.replaceAll('"', '\\"')}"`,
    `\`${value}\``,
    `\`${value.replaceAll('`', '\\`')}\``,
  ];
  const candidate = candidates.find((item) => (parse(`${name}=${item}`)[name] ?? '') === value);
  if (candidate === undefined) {
    throw new Error(`${name} cannot be represented safely in agent/.env.development`);
  }
  return `${name}=${candidate}`;
};

let source = readFileSync(sourcePath, 'utf8');
const userValues = parse(source);
source = removeAssignments('GARAGE_')(source);
source = removeAssignments('SEARXNG_')(source);

for (const name of serviceSecretNames) {
  const value = process.env[name];
  if (value && source.includes(value)) throw new Error(leakedValueError);
}

const garageAssignments = garageKeys.map((name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in storage/.env.local`);
  return serialize(name, value);
});
const searxngAssignments = searxngKeys.map((name) => {
  if (name === 'SEARXNG_API_KEY' && typeof userValues[name] === 'string' && userValues[name] !== '') {
    return serialize(name, userValues[name]);
  }
  return serialize(name, process.env[name] ?? '');
});
const separator = source.length > 0 && !source.endsWith('\n') ? '\n' : '';
writeFileSync(outputPath, `${source}${separator}${[...garageAssignments, ...searxngAssignments].join('\n')}\n`);
NODE
  chmod 600 "$tmp"
  if [[ -f "$AGENT_DEV_ENV_FILE" ]] && cmp -s "$tmp" "$AGENT_DEV_ENV_FILE"; then
    rm "$tmp"
    chmod 600 "$AGENT_DEV_ENV_FILE"
  else
    mv -f "$tmp" "$AGENT_DEV_ENV_FILE"
    chmod 600 "$AGENT_DEV_ENV_FILE"
  fi
}

write_env_value() {
  local source_env="$1"
  local name="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp "${source_env}.tmp.XXXXXX")"
  chmod 600 "$tmp"
  node - "$source_env" "$name" "$value" "$tmp" <<'NODE' || { rm -f "$tmp"; echo "write_env_value failed for $name" >&2; return 1; }
const { readFileSync, writeFileSync } = require('node:fs');
const { parse } = require('dotenv');
const [sourcePath, varName, varValue, outputPath] = process.argv.slice(2);
if (/[\r\n]/.test(varValue)) throw new Error(`${varName} must not contain CR or LF`);
const candidates = [
  varValue,
  `'${varValue}'`,
  `'${varValue.replaceAll("'", "\\'")}'`,
  `"${varValue}"`,
  `"${varValue.replaceAll('"', '\\"')}"`,
];
const candidate = candidates.find((item) => (parse(`${varName}=${item}`)[varName] ?? '') === varValue);
if (candidate === undefined) throw new Error(`${varName} cannot be represented safely`);
const text = readFileSync(sourcePath, 'utf8');
const lines = text.split(/\r?\n/);
if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
let updated = false;
for (let i = 0; i < lines.length; i += 1) {
  const match = lines[i].match(new RegExp(`^[^\\S\\r\\n]*(?:export[^\\S\\r\\n]+)?${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^\\S\\r\\n]*=[^\\S\\r\\n]*|:[^\\S\\r\\n]+)(.*)$`));
  if (match) {
    lines[i] = `${varName}=${candidate}`;
    updated = true;
    break;
  }
}
if (!updated) lines.push(`${varName}=${candidate}`);
writeFileSync(outputPath, `${lines.join('\n')}\n`, { mode: 0o600 });
NODE
  chmod 600 "$tmp"
  if [[ -f "$source_env" ]] && cmp -s "$tmp" "$source_env"; then
    rm "$tmp"
    chmod 600 "$source_env"
  else
    mv -f "$tmp" "$source_env"
    chmod 600 "$source_env"
  fi
}

prompt_for_env() {
  local source_env="$1"
  local name="$2"
  local default="$3"
  local mode="$4"   # "required", "default", or "optional"
  local current
  current="$(node - "$source_env" "$name" <<'NODE'
const { readFileSync } = require('node:fs');
const { parse } = require('dotenv');
const [sourcePath, varName] = process.argv.slice(2);
const values = parse(readFileSync(sourcePath, 'utf8'));
process.stdout.write(values[varName] ?? '');
NODE
)"

  if [[ -n "$current" ]]; then
    return 0
  fi

  if [[ ! -t 0 ]]; then
    if [[ "$mode" == "required" ]]; then
      echo "WARNING: $name is required but stdin is not a TTY. Edit $source_env manually." >&2
    fi
    return 0
  fi

  local prompt_text
  if [[ "$mode" == "required" ]]; then
    prompt_text="${name} (required): "
  elif [[ "$mode" == "default" ]]; then
    prompt_text="${name} [${default}]: "
  else
    prompt_text="${name} (optional, Enter to skip): "
  fi

  local value=""
  if [[ "$name" == "LLM_API_KEY" || "$name" == "TELEGRAM_BOT_TOKEN" || "$name" == "RESEND_API_KEY" || "$name" == "AGENT_SERVICE_TOKEN" ]]; then
    read -r -s -p "$prompt_text" value || value=""
    echo ""
  else
    read -r -p "$prompt_text" value || value=""
  fi

  if [[ -z "$value" ]]; then
    if [[ "$mode" == "required" ]]; then
      echo "${name} is required." >&2
      return 1
    fi
    if [[ "$mode" == "default" ]]; then
      value="$default"
    else
      return 0
    fi
  fi

  write_env_value "$source_env" "$name" "$value"
}

run_prompts() {
  prompt_for_env "$AGENT_ENV_FILE" LLM_API_KEY "" required || return 1
  prompt_for_env "$AGENT_ENV_FILE" LLM_BASE_URL "https://llm.rafiqspace.ai/v1" default
  prompt_for_env "$AGENT_ENV_FILE" LLM_DEFAULT_MODEL "qwen3.6-35b-a3b-fast" default
  prompt_for_env "$AGENT_ENV_FILE" LLM_DISPLAY_NAME "Rafiqspace LLM" default
  prompt_for_env "$AGENT_ENV_FILE" LLM_MODELS "qwen3.6-35b-a3b-fast,qwen3.6-35b-a3b" default
  prompt_for_env "$AGENT_ENV_FILE" TELEGRAM_BOT_TOKEN "" optional
  prompt_for_env "$AGENT_ENV_FILE" RESEND_API_KEY "" optional
  prompt_for_env "$AGENT_ENV_FILE" RESEND_FROM_EMAIL "Chekku <onboarding@resend.dev>" default
  prompt_for_env "$AGENT_ENV_FILE" AGENT_SERVICE_TOKEN "" optional
  return 0
}

run_prompts || {
  echo "Setup aborted; at least one required value is missing." >&2
  exit 1
}

render_agent_dev_env

print_summary() {
  local required_missing
  required_missing="$(node - "$AGENT_ENV_FILE" <<'NODE'
const { readFileSync } = require('node:fs');
const { parse } = require('dotenv');
const values = parse(readFileSync(process.argv[2], 'utf8'));
const required = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_DEFAULT_MODEL'];
process.stdout.write(required.filter((name) => !values[name]).join(','));
NODE
)"

  echo "Setup complete."
  echo ""
  echo "Files generated:"
  echo "  - storage/.env.local"
  echo "  - storage/.garage/garage.toml"
  echo "  - searxng/.env.local"
  echo "  - agent/.env.development"
  echo ""
  echo "Files updated from your input:"
  echo "  - agent/.env"
  echo ""

  if [[ -n "$required_missing" ]]; then
    echo "Required values you still need to fill (edit agent/.env):"
    local IFS=','
    for name in $required_missing; do
      echo "  - ${name}"
    done
    echo ""
  fi

  echo "Optional integrations you can configure later:"
  echo "  - TELEGRAM_BOT_TOKEN   (social-media-agent)"
  echo "  - RESEND_API_KEY       (send-email tool)"
  echo "  - MAESTRO_ENABLED      (qa-android-agent)"
  echo ""
  echo "Next step: npm run dev:sh"
}

print_summary
