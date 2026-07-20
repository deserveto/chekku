#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/searxng/.env.local"
SETTINGS_FILE="$ROOT/searxng/settings.yml"
AGENT_ENV_FILE="$ROOT/agent/.env"
AGENT_DEVELOPMENT_ENV_FILE="$ROOT/agent/.env.development"

unset SEARXNG_SECRET SEARXNG_CONFIG_HASH SEARXNG_BASE_URL SEARXNG_API_KEY
ENV_FILE_EXISTED=0
if [[ -f "$ENV_FILE" ]]; then
  ENV_FILE_EXISTED=1
fi

render_searxng_env() (
  local env_tmp
  env_tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
  trap 'rm -f "$env_tmp"' EXIT
  chmod 600 "$env_tmp"

  if ! node - "$SETTINGS_FILE" "$env_tmp" "$ENV_FILE" "$ENV_FILE_EXISTED" <<'NODE'
const { chmodSync, linkSync, readFileSync, writeFileSync } = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');

const [settingsPath, outputPath, envPath, envFileExisted] = process.argv.slice(2);
const names = ['SEARXNG_SECRET', 'SEARXNG_CONFIG_HASH', 'SEARXNG_BASE_URL', 'SEARXNG_API_KEY'];
const invalidStateMessage = 'Invalid SearXNG local environment state.';

const parseState = (content) => {
  const lines = content.split('\n');
  if (lines.pop() !== '' || lines.length !== names.length) throw new Error(invalidStateMessage);
  const values = {};
  for (let index = 0; index < names.length; index += 1) {
    const prefix = `${names[index]}=`;
    if (!lines[index].startsWith(prefix)) throw new Error(invalidStateMessage);
    values[names[index]] = lines[index].slice(prefix.length);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(values.SEARXNG_SECRET) ||
      !/^[a-f0-9]{64}$/.test(values.SEARXNG_CONFIG_HASH) ||
      values.SEARXNG_BASE_URL !== 'http://127.0.0.1:8888' ||
      values.SEARXNG_API_KEY !== '') {
    throw new Error(invalidStateMessage);
  }
  return values;
};

try {
  const settings = readFileSync(settingsPath, 'utf8');
  const existing = envFileExisted === '1' ? parseState(readFileSync(envPath, 'utf8')) : undefined;
  const secret = existing?.SEARXNG_SECRET ?? randomBytes(32).toString('base64url');
  const configHash = createHash('sha256').update(settings).digest('hex');
  writeFileSync(outputPath, [
    `SEARXNG_SECRET=${secret}`,
    `SEARXNG_CONFIG_HASH=${configHash}`,
    'SEARXNG_BASE_URL=http://127.0.0.1:8888',
    'SEARXNG_API_KEY=',
    '',
  ].join('\n'), { mode: 0o600 });

  if (envFileExisted === '0') {
    try {
      linkSync(outputPath, envPath);
      chmodSync(envPath, 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
} catch (error) {
  if (error?.message !== invalidStateMessage) throw error;
  process.stderr.write(`${invalidStateMessage}\n`);
  process.exitCode = 1;
}
NODE
  then
    return 1
  fi

  chmod 600 "$env_tmp"
  if ((ENV_FILE_EXISTED == 0)); then
    rm -f "$env_tmp"
    chmod 600 "$ENV_FILE"
  elif cmp -s "$env_tmp" "$ENV_FILE"; then
    chmod 600 "$ENV_FILE"
  else
    mv -f "$env_tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
)

if ! render_searxng_env; then
  return 1 2>/dev/null || exit 1
fi

load_searxng_env() {
  local parsed
  if ! parsed="$(node - "$ENV_FILE" <<'NODE'
const { readFileSync } = require('node:fs');

const [envPath] = process.argv.slice(2);
const names = ['SEARXNG_SECRET', 'SEARXNG_CONFIG_HASH', 'SEARXNG_BASE_URL', 'SEARXNG_API_KEY'];
const invalidStateMessage = 'Invalid SearXNG local environment state.';

try {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  if (lines.pop() !== '' || lines.length !== names.length) throw new Error(invalidStateMessage);
  const values = {};
  for (let index = 0; index < names.length; index += 1) {
    const prefix = `${names[index]}=`;
    if (!lines[index].startsWith(prefix)) throw new Error(invalidStateMessage);
    values[names[index]] = lines[index].slice(prefix.length);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(values.SEARXNG_SECRET) ||
      !/^[a-f0-9]{64}$/.test(values.SEARXNG_CONFIG_HASH) ||
      values.SEARXNG_BASE_URL !== 'http://127.0.0.1:8888' ||
      values.SEARXNG_API_KEY !== '') {
    throw new Error(invalidStateMessage);
  }
  process.stdout.write([
    values.SEARXNG_SECRET,
    values.SEARXNG_CONFIG_HASH,
    values.SEARXNG_BASE_URL,
  ].join('\t'));
} catch (error) {
  if (error?.message !== invalidStateMessage) throw error;
  process.stderr.write(`${invalidStateMessage}\n`);
  process.exitCode = 1;
}
NODE
)"; then
    return 1
  fi

  IFS=$'\t' read -r SEARXNG_SECRET SEARXNG_CONFIG_HASH SEARXNG_BASE_URL <<< "$parsed"
  SEARXNG_API_KEY=''
  export SEARXNG_SECRET SEARXNG_CONFIG_HASH SEARXNG_BASE_URL SEARXNG_API_KEY
}

if ! load_searxng_env; then
  return 1 2>/dev/null || exit 1
fi

render_agent_env() (
  local agent_env_source agent_env_tmp
  if [[ -f "$AGENT_DEVELOPMENT_ENV_FILE" ]]; then
    agent_env_source="$AGENT_DEVELOPMENT_ENV_FILE"
  else
    agent_env_source="$AGENT_ENV_FILE"
  fi
  agent_env_tmp="$(mktemp "${AGENT_DEVELOPMENT_ENV_FILE}.tmp.XXXXXX")"
  trap 'rm -f "$agent_env_tmp"' EXIT
  chmod 600 "$agent_env_tmp"

  if ! node - "$agent_env_source" "$agent_env_tmp" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const { parse } = require('dotenv');

const [sourcePath, outputPath] = process.argv.slice(2);
const searxngKeys = ['SEARXNG_BASE_URL', 'SEARXNG_API_KEY'];
const assignmentPattern = new RegExp(
  '^[^\\S\\r\\n]*(?:export[^\\S\\r\\n]+)?([\\w.-]+)(?:[^\\S\\r\\n]*=[^\\S\\r\\n]*|:[^\\S\\r\\n]+)(.*)$',
);
const invalidAssignmentError = 'SearXNG application environment contains an invalid assignment.';
const leakedValueError = 'SearXNG service-only values must not appear in agent environment.';

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
    if (!assignment || !assignment[1].startsWith('SEARXNG_')) {
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
for (const value of [process.env.SEARXNG_SECRET, process.env.SEARXNG_CONFIG_HASH]) {
  if (value && source.includes(value)) throw new Error(leakedValueError);
}

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
  const candidate = candidates.find((item) => (parse(`${name}=${item}`)[name] ?? '') === value);
  if (candidate === undefined) {
    throw new Error(`${name} cannot be represented safely in agent/.env.development`);
  }
  return `${name}=${candidate}`;
};

const overrides = searxngKeys.map((name) => serialize(name, process.env[name] ?? ''));
const separator = source.length > 0 && !source.endsWith('\n') ? '\n' : '';
writeFileSync(outputPath, `${source}${separator}${overrides.join('\n')}\n`);
NODE
  then
    return 1
  fi

  chmod 600 "$agent_env_tmp"
  if [[ -f "$AGENT_DEVELOPMENT_ENV_FILE" ]] && cmp -s "$agent_env_tmp" "$AGENT_DEVELOPMENT_ENV_FILE"; then
    chmod 600 "$AGENT_DEVELOPMENT_ENV_FILE"
  else
    mv -f "$agent_env_tmp" "$AGENT_DEVELOPMENT_ENV_FILE"
    chmod 600 "$AGENT_DEVELOPMENT_ENV_FILE"
  fi
)

if [[ -f "$AGENT_ENV_FILE" ]]; then
  if ! render_agent_env; then
    return 1 2>/dev/null || exit 1
  fi
fi
