#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/storage/.env.local"
AGENT_ENV_FILE="$ROOT/agent/.env"
AGENT_DEVELOPMENT_ENV_FILE="$ROOT/agent/.env.development"
CONFIG_DIR="$ROOT/storage/.garage"
CONFIG_TEMPLATE="$ROOT/storage/garage.toml.template"
CONFIG_FILE="$CONFIG_DIR/garage.toml"

mkdir -p "$CONFIG_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  ENV_TMP="$ENV_FILE.tmp.$$"
  node >"$ENV_TMP" <<'NODE'
const crypto = require('node:crypto');

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

process.stdout.write([
  'GARAGE_ENDPOINT=http://127.0.0.1:3900',
  'GARAGE_REGION=garage',
  'GARAGE_BUCKET=chekku-objects',
  `GARAGE_ACCESS_KEY_ID=GK${hex(12).toUpperCase()}`,
  `GARAGE_SECRET_ACCESS_KEY=${hex(32)}`,
  `GARAGE_RPC_SECRET=${hex(32)}`,
  `GARAGE_ADMIN_TOKEN=${token()}`,
  `GARAGE_METRICS_TOKEN=${token()}`,
  '',
].join('\n'));
NODE
  chmod 600 "$ENV_TMP"
  mv "$ENV_TMP" "$ENV_FILE"
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export GARAGE_DEFAULT_ACCESS_KEY="$GARAGE_ACCESS_KEY_ID"
export GARAGE_DEFAULT_SECRET_KEY="$GARAGE_SECRET_ACCESS_KEY"
export GARAGE_DEFAULT_BUCKET="$GARAGE_BUCKET"

render_agent_env() (
  local agent_env_tmp
  agent_env_tmp="$(mktemp "${AGENT_DEVELOPMENT_ENV_FILE}.tmp.XXXXXX")"
  trap 'rm -f "$agent_env_tmp"' EXIT
  chmod 600 "$agent_env_tmp"

  node - "$AGENT_ENV_FILE" "$agent_env_tmp" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const { parse } = require('dotenv');

const [sourcePath, outputPath] = process.argv.slice(2);
const garageKeys = [
  'GARAGE_ENDPOINT',
  'GARAGE_REGION',
  'GARAGE_BUCKET',
  'GARAGE_ACCESS_KEY_ID',
  'GARAGE_SECRET_ACCESS_KEY',
];
const assignmentPattern = new RegExp(
  '^[ \\t]*(?:export[ \\t]+)?([\\w.-]+)(?:[ \\t]*=[ \\t]*|:[ \\t]+)(.*)$',
);
const invalidAssignmentError = 'Garage application environment contains an invalid assignment.';

const hasClosingQuote = (value, quote) => {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === quote && value[index - 1] !== '\\') {
      return true;
    }
  }
  return false;
};

const removeAssignments = (input) => {
  const lines = input.match(/[^\r\n]*(?:\r\n|\n|$)/g)?.filter(Boolean) ?? [];
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const content = lines[index].replace(/\r?\n$/, '');
    const assignment = content.match(assignmentPattern);
    if (!assignment || !assignment[1].startsWith('GARAGE_')) {
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

const source = removeAssignments(readFileSync(sourcePath, 'utf8'));

const serialize = (name, value) => {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${name} must not contain CR or LF`);
  }

  const candidates = [
    value,
    `'${value}'`,
    `'${value.replaceAll("'", "\\'")}'`,
    `"${value}"`,
    `"${value.replaceAll('"', '\\"')}"`,
    `\`${value}\``,
    `\`${value.replaceAll('`', '\\`')}\``,
  ];
  const candidate = candidates.find((item) => parse(`${name}=${item}`)[name] === value);
  if (!candidate) {
    throw new Error(`${name} cannot be represented safely in agent/.env.development`);
  }
  return `${name}=${candidate}`;
};

const overrides = garageKeys.map((name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in storage/.env.local`);
  return serialize(name, value);
});
const separator = source.length > 0 && !source.endsWith('\n') ? '\n' : '';

writeFileSync(outputPath, `${source}${separator}${overrides.join('\n')}\n`);
NODE

  chmod 600 "$agent_env_tmp"
  if [[ -f "$AGENT_DEVELOPMENT_ENV_FILE" ]] && cmp -s "$agent_env_tmp" "$AGENT_DEVELOPMENT_ENV_FILE"; then
    chmod 600 "$AGENT_DEVELOPMENT_ENV_FILE"
  else
    mv -f "$agent_env_tmp" "$AGENT_DEVELOPMENT_ENV_FILE"
    chmod 600 "$AGENT_DEVELOPMENT_ENV_FILE"
  fi
)

if [[ -f "$AGENT_ENV_FILE" ]]; then
  render_agent_env
else
  rm -f "$AGENT_DEVELOPMENT_ENV_FILE"
fi

CONFIG_TMP="$CONFIG_FILE.tmp.$$"
node - "$CONFIG_TEMPLATE" "$CONFIG_TMP" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');

const [templatePath, outputPath] = process.argv.slice(2);
const required = [
  'GARAGE_RPC_SECRET',
  'GARAGE_ADMIN_TOKEN',
  'GARAGE_METRICS_TOKEN',
  'GARAGE_REGION',
];
let config = readFileSync(templatePath, 'utf8');

for (const name of required) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in storage/.env.local`);
  config = config.replaceAll(`\${${name}}`, value);
}

writeFileSync(outputPath, config, { mode: 0o600 });
NODE
chmod 600 "$CONFIG_TMP"
export GARAGE_CONFIG_CHANGED=0
if [[ -f "$CONFIG_FILE" ]] && cmp -s "$CONFIG_TMP" "$CONFIG_FILE"; then
  rm "$CONFIG_TMP"
else
  mv "$CONFIG_TMP" "$CONFIG_FILE"
  export GARAGE_CONFIG_CHANGED=1
fi
