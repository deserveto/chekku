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
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

render_searxng_env() (
  local env_tmp
  env_tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
  trap 'rm -f "$env_tmp"' EXIT
  chmod 600 "$env_tmp"

  node - "$SETTINGS_FILE" "$env_tmp" "$ENV_FILE" "$ENV_FILE_EXISTED" <<'NODE'
const { chmodSync, linkSync, readFileSync, writeFileSync } = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');

const [settingsPath, outputPath, envPath, envFileExisted] = process.argv.slice(2);
const settings = readFileSync(settingsPath, 'utf8');
const existingSecret = process.env.SEARXNG_SECRET;
if (envFileExisted === '1' && existingSecret === undefined) {
  throw new Error('Missing SEARXNG_SECRET in searxng/.env.local');
}
if (existingSecret !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(existingSecret)) {
  throw new Error('Invalid SEARXNG_SECRET in searxng/.env.local');
}

const secret = existingSecret ?? randomBytes(32).toString('base64url');
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
NODE

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

render_searxng_env

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

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

  node - "$agent_env_source" "$agent_env_tmp" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const { parse } = require('dotenv');

const [sourcePath, outputPath] = process.argv.slice(2);
const searxngKeys = ['SEARXNG_BASE_URL', 'SEARXNG_API_KEY'];
const assignmentPattern = new RegExp(
  '^[ \\t]*(?:export[ \\t]+)?([\\w.-]+)(?:[ \\t]*=[ \\t]*|:[ \\t]+)(.*)$',
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
fi
