import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { parse } from 'dotenv';
import { afterEach, describe, expect, it } from 'vitest';

const sourceRoot = resolve(import.meta.dirname, '..');
const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const fixtures: string[] = [];

const validAgentEnv = [
  'NODE_ENV=development',
  'LLM_BASE_URL=https://models.example.test/v1',
  'LLM_API_KEY=test-model-key',
  'LLM_DEFAULT_MODEL=test-model',
  'GARAGE_ENDPOINT=stale-endpoint',
  'GARAGE_REGION=stale-region',
  'GARAGE_BUCKET=stale-bucket',
  'GARAGE_ACCESS_KEY_ID=stale-access-key',
  'GARAGE_SECRET_ACCESS_KEY=stale-secret-key',
  '',
].join('\n');
const invalidSearxngAssignmentError = 'SearXNG application environment contains an invalid assignment.';
const leakedSearxngValueError = 'SearXNG service-only values must not appear in agent environment.';

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
  chmodSync(path, 0o755);
}

function shellValue(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function storageEnv(values: Record<string, string>): string {
  return [
    ...Object.entries(values).map(([name, value]) => `${name}=${shellValue(value)}`),
    'GARAGE_RPC_SECRET=rpc-secret',
    'GARAGE_ADMIN_TOKEN=admin-token',
    'GARAGE_METRICS_TOKEN=metrics-token',
    '',
  ].join('\n');
}

function fixture(options: {
  tmux?: boolean;
  npm?: boolean;
  agentEnv?: string | null;
  rejectedSleep?: string;
  captureNpmEnv?: boolean;
} = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'chekku-dev-'));
  fixtures.push(root);
  for (const directory of ['scripts', 'storage', 'searxng', 'agent', 'bin']) {
    mkdirSync(resolve(root, directory));
  }
  for (const path of [
    'scripts/dev.sh',
    'scripts/storage-env.sh',
    'scripts/searxng-env.sh',
    'storage/garage.toml.template',
    'searxng/settings.yml',
    'compose.yaml',
    '.gitignore',
  ]) {
    copyFileSync(resolve(sourceRoot, path), resolve(root, path));
  }
  if (options.agentEnv !== null) writeFileSync(resolve(root, 'agent/.env'), options.agentEnv ?? validAgentEnv);

  executable(resolve(root, 'bin/docker'), `
echo "$*" >> "$MOCK_LOG/docker"
if [[ "\${HANG_DOCKER_COMMAND:-}" == "$1" ]] ||
  { [[ "\${HANG_DOCKER_COMMAND:-}" == ps ]] && [[ "$*" == *" ps -q garage" ]]; }; then
  printf '%s\\n' "$BASHPID" > "$MOCK_LOG/orphan-group"
  (
    if [[ "\${TERM_RESISTANT_DOCKER_DESCENDANT:-0}" == 1 ]]; then trap '' TERM; fi
    sleep "\${HANG_DOCKER_SECONDS:-3}"
    touch "$MOCK_LOG/orphan-finished"
  ) &
  printf '%s\\n' "$!" > "$MOCK_LOG/orphan-pid"
  if [[ "\${TERM_RESISTANT_DOCKER_DESCENDANT:-0}" == 1 ]]; then trap 'exit 0' TERM; fi
  wait
fi
if [[ "$1" == compose ]]; then
  if [[ "$*" == *" version" ]]; then [[ "\${COMPOSE_AVAILABLE:-1}" == 1 ]]; exit; fi
  if [[ "$*" == *" config --quiet" ]]; then [[ "\${COMPOSE_CONFIG_FAIL:-0}" != 1 ]]; exit; fi
  if [[ "$*" == *" ps -q garage" ]]; then
    if [[ "\${GARAGE_RUNNING:-1}" == 1 ]]; then printf 'garage-id\\n'; fi
    exit 0
  fi
  if [[ "$*" == *" up "* ]]; then exit 0; fi
fi
if [[ "$1" == inspect ]]; then
  if [[ "\${DOCKER_HEALTH_ON_SECOND:-0}" == 1 ]]; then
    count=0
    if [[ -f "$MOCK_LOG/inspect-count" ]]; then count="$(<"$MOCK_LOG/inspect-count")"; fi
    count=$((count + 1))
    printf '%s' "$count" > "$MOCK_LOG/inspect-count"
    if ((count < 2)); then printf 'starting\\n'; else printf 'healthy\\n'; fi
  else
    printf '%s\\n' "\${DOCKER_HEALTH:-healthy}"
  fi
fi
`);

  if (options.rejectedSleep) {
    executable(resolve(root, 'bin/sleep'), `
if [[ "$1" == "${options.rejectedSleep}" ]]; then exit 42; fi
/usr/bin/sleep "$@"
`);
  }

  if (options.tmux) {
    executable(resolve(root, 'bin/tmux'), `
echo "$*" >> "$MOCK_LOG/tmux"
case "$1" in
  has-session) [[ -f "$MOCK_LOG/tmux-session" ]] ;;
  new-session) touch "$MOCK_LOG/tmux-session" ;;
  split-window) [[ "\${TMUX_SPLIT_FAIL:-0}" != 1 ]] ;;
  select-layout) [[ "\${TMUX_LAYOUT_FAIL:-0}" != 1 ]] ;;
  kill-session) rm -f "$MOCK_LOG/tmux-session" ;;
esac
`);
  }

  if (options.npm) {
    executable(resolve(root, 'bin/npm'), `
role="\${*: -1}"
if [[ "$role" == dev:client ]]; then sleep 0.5; exit 7; fi
printf '%s\n' "$BASHPID" > "$MOCK_LOG/app-group"
trap 'printf "agent-wrapper-term\\n" >> "$MOCK_LOG/signals"; wait; exit 0' TERM INT
(
  if [[ "\${TERM_RESISTANT_NPM_DESCENDANT:-0}" == 1 ]]; then
    trap '' TERM
  else
    trap 'printf "agent-child-term\\n" >> "$MOCK_LOG/signals"; exit 0' TERM INT
  fi
  printf '%s\n' "$BASHPID" > "$MOCK_LOG/app-child"
  while true; do sleep 1; done
) &
printf 'agent-ready\\n' >> "$MOCK_LOG/signals"
wait
`);
  }

  if (options.captureNpmEnv) {
    executable(resolve(root, 'bin/npm'), `
role="\${*: -1}"
role="\${role/:/_}"
env | grep '^GARAGE_' | sort > "$MOCK_LOG/env-$role"
touch "$MOCK_LOG/ready-$role"
for _ in {1..100}; do
  if [[ -f "$MOCK_LOG/ready-dev_agent" && -f "$MOCK_LOG/ready-dev_client" ]]; then exit 0; fi
  sleep 0.01
done
exit 1
`);
  }

  return root;
}

function run(root: string, args: string[], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  const log = resolve(root, 'mock-log');
  mkdirSync(log, { recursive: true });
  return spawnSync(bash, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      ...env,
      MOCK_LOG: log,
      NODE_PATH: resolve(sourceRoot, 'node_modules'),
      PATH: `${resolve(root, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
    },
  });
}

function runAsync(
  root: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const log = resolve(root, 'mock-log');
  mkdirSync(log, { recursive: true });
  const child = spawn(bash, args, {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      MOCK_LOG: log,
      NODE_PATH: resolve(sourceRoot, 'node_modules'),
      PATH: `${resolve(root, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += String(data); });
  child.stderr.on('data', (data) => { stderr += String(data); });
  return new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolveResult({ status, stdout, stderr }));
  });
}

async function waitForPath(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function runDev(root: string, env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return run(root, ['scripts/dev.sh'], env);
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('storage environment generation', () => {
  it('safely replaces stale Garage values with exactly five current application values', () => {
    const root = fixture({
      agentEnv: [
        'NODE_ENV=development',
        String.raw`LLM_API_KEY='key with spaces "quotes" C:\models literal\n # $token 雪'`,
        ' export GARAGE_ENDPOINT = stale-endpoint',
        '  GARAGE_REGION="stale region"',
        '\tGARAGE_BUCKET \t= stale-bucket',
        'export GARAGE_ACCESS_KEY_ID=stale-access-key',
        'GARAGE_SECRET_ACCESS_KEY = stale-secret-key',
        'UNRELATED = preserve-this-line',
        'WEB_URL=http://localhost:3000',
      ].join('\r\n'),
    });
    const garageValues = {
      GARAGE_ENDPOINT: 'https://garage.example.test/object path?x=a=b&token=A+/==$cash#frag',
      GARAGE_REGION: String.raw`region 'single' \`tick\` C:\path 雪`,
      GARAGE_BUCKET: String.raw`bucket "double" C:\garage + / = $value 雪`,
      GARAGE_ACCESS_KEY_ID: String.raw`GK+base64/==$value\nliteral`,
      GARAGE_SECRET_ACCESS_KEY: String.raw`secret 'single' "double" C:\vault +/==$value 雪`,
    };
    writeFileSync(resolve(root, 'storage/.env.local'), storageEnv(garageValues));

    const result = run(root, ['scripts/storage-env.sh']);
    const generated = readFileSync(resolve(root, 'agent/.env.development'), 'utf8');
    const values = parse(generated);

    expect(result.status, result.stderr).toBe(0);
    expect(values.LLM_API_KEY).toBe(parse(readFileSync(resolve(root, 'agent/.env'))).LLM_API_KEY);
    expect(generated).toContain('UNRELATED = preserve-this-line');
    expect(values.WEB_URL).toBe('http://localhost:3000');
    for (const [name, value] of Object.entries(garageValues)) {
      expect(values[name]).toBe(value);
      expect(generated.match(new RegExp(`^${name}=`, 'gm'))).toHaveLength(1);
      expect(result.stdout).not.toContain(value);
      expect(result.stderr).not.toContain(value);
    }
    expect(generated).not.toContain('stale-');
    expect(generated).not.toMatch(/^GARAGE_(?:RPC_SECRET|ADMIN_TOKEN|METRICS_TOKEN)=/m);
  });

  it('rejects line breaks with a key-specific error and no secret output', () => {
    const root = fixture();
    const unsafe = 'private first line\nprivate second line';
    writeFileSync(resolve(root, 'storage/.env.local'), storageEnv({
      GARAGE_ENDPOINT: 'http://garage.test:3900',
      GARAGE_REGION: unsafe,
      GARAGE_BUCKET: 'chekku-objects',
      GARAGE_ACCESS_KEY_ID: 'access-key',
      GARAGE_SECRET_ACCESS_KEY: 'secret-key',
    }));

    const result = run(root, ['scripts/storage-env.sh']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('GARAGE_REGION must not contain CR or LF');
    expect(`${result.stdout}${result.stderr}`).not.toContain(unsafe);
  });

  it('creates private stable random credentials and stable generated config', () => {
    const root = fixture();
    const first = run(root, ['scripts/storage-env.sh']);
    const envPath = resolve(root, 'storage/.env.local');
    const configPath = resolve(root, 'storage/.garage/garage.toml');
    const envContent = readFileSync(envPath, 'utf8');
    const configContent = readFileSync(configPath, 'utf8');
    const configInode = statSync(configPath).ino;
    const second = run(root, ['scripts/storage-env.sh']);

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(parse(envContent).GARAGE_BUCKET).toBe('chekku-objects');
    expect(parse(envContent).GARAGE_ACCESS_KEY_ID).toMatch(/^GK[A-F0-9]{24}$/);
    expect(readFileSync(envPath, 'utf8')).toBe(envContent);
    expect(readFileSync(configPath, 'utf8')).toBe(configContent);
    expect(statSync(configPath).ino).toBe(configInode);
    if (process.platform !== 'win32') {
      expect(statSync(envPath).mode & 0o077).toBe(0);
      expect(statSync(configPath).mode & 0o077).toBe(0);
    }
  });

  it('removes stale generated agent environment when source disappears', () => {
    const root = fixture();
    expect(run(root, ['scripts/storage-env.sh']).status).toBe(0);
    rmSync(resolve(root, 'agent/.env'));
    expect(run(root, ['scripts/storage-env.sh']).status).toBe(0);
    expect(existsSync(resolve(root, 'agent/.env.development'))).toBe(false);
  });
});

describe('SearXNG environment generation', () => {
  it('keeps a private stable secret and updates the tracked settings hash', () => {
    const root = fixture({
      agentEnv: [
        validAgentEnv.trimEnd(),
        'SEARXNG_BASE_URL=https://stale.example.test',
        ' export SEARXNG_API_KEY = stale-key',
        'SEARXNG_BASE_URL=duplicate-stale-value',
        '',
      ].join('\n'),
    });
    expect(run(root, ['scripts/storage-env.sh']).status).toBe(0);

    const first = run(root, ['scripts/searxng-env.sh']);
    const envPath = resolve(root, 'searxng/.env.local');
    const firstContent = readFileSync(envPath, 'utf8');
    const firstValues = parse(firstContent);
    const firstAgentContent = readFileSync(resolve(root, 'agent/.env.development'), 'utf8');

    expect(first.status, first.stderr).toBe(0);
    expect(firstValues.SEARXNG_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(firstValues.SEARXNG_CONFIG_HASH).toMatch(/^[a-f0-9]{64}$/);
    expect(firstValues.SEARXNG_BASE_URL).toBe('http://127.0.0.1:8888');
    expect(firstValues.SEARXNG_API_KEY).toBe('');
    expect(firstAgentContent.match(/^SEARXNG_BASE_URL=/gm)).toHaveLength(1);
    expect(firstAgentContent.match(/^SEARXNG_API_KEY=/gm)).toHaveLength(1);
    expect(parse(firstAgentContent).SEARXNG_BASE_URL).toBe('http://127.0.0.1:8888');
    expect(parse(firstAgentContent).SEARXNG_API_KEY).toBe('');
    expect(firstAgentContent).not.toMatch(/^SEARXNG_(?:SECRET|CONFIG_HASH)=/m);
    expect(firstAgentContent.includes(firstValues.SEARXNG_SECRET!)).toBe(false);
    expect(firstAgentContent.includes(firstValues.SEARXNG_CONFIG_HASH!)).toBe(false);
    expect(firstAgentContent).not.toContain('stale');
    expect((first.stdout + first.stderr).includes(firstValues.SEARXNG_SECRET!)).toBe(false);

    const unchanged = run(root, ['scripts/searxng-env.sh']);
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(readFileSync(envPath, 'utf8')).toBe(firstContent);

    appendFileSync(resolve(root, 'searxng/settings.yml'), '\n# changed\n');
    const changed = run(root, ['scripts/searxng-env.sh']);
    const changedValues = parse(readFileSync(envPath, 'utf8'));

    expect(changed.status, changed.stderr).toBe(0);
    expect(changedValues.SEARXNG_SECRET === firstValues.SEARXNG_SECRET).toBe(true);
    expect(changedValues.SEARXNG_CONFIG_HASH).not.toBe(firstValues.SEARXNG_CONFIG_HASH);
    expect((changed.stdout + changed.stderr).includes(firstValues.SEARXNG_SECRET!)).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(envPath).mode & 0o077).toBe(0);
    }
  });

  it('exports the persisted winner from concurrent first runs', async () => {
    const root = fixture({ agentEnv: null });
    const log = resolve(root, 'mock-log');
    const realNode = process.execPath.replaceAll('\\', '/');
    executable(resolve(root, 'bin/node'), `
if [[ "$1" == - ]] && mkdir "$MOCK_LOG/first-node" 2>/dev/null; then
  ${shellValue(realNode)} "$@"
  touch "$MOCK_LOG/first-generated"
  for _ in {1..500}; do
    if [[ -f "$MOCK_LOG/caller-2-sourced" ]]; then exit 0; fi
    sleep 0.01
  done
  exit 70
fi
exec ${shellValue(realNode)} "$@"
`);

    const first = runAsync(root, ['-c', [
      'source scripts/searxng-env.sh',
      'printf %s "$SEARXNG_SECRET" > "$MOCK_LOG/caller-1"',
    ].join('; ')]);
    await waitForPath(resolve(log, 'first-generated'));
    const second = runAsync(root, ['-c', [
      'source scripts/searxng-env.sh',
      'printf %s "$SEARXNG_SECRET" > "$MOCK_LOG/caller-2"',
      'touch "$MOCK_LOG/caller-2-sourced"',
    ].join('; ')]);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    const persisted = parse(readFileSync(resolve(root, 'searxng/.env.local'), 'utf8'));
    const firstSecret = readFileSync(resolve(log, 'caller-1'), 'utf8');
    const secondSecret = readFileSync(resolve(log, 'caller-2'), 'utf8');

    expect(firstResult.status, firstResult.stderr).toBe(0);
    expect(secondResult.status, secondResult.stderr).toBe(0);
    expect(firstSecret === persisted.SEARXNG_SECRET).toBe(true);
    expect(secondSecret === persisted.SEARXNG_SECRET).toBe(true);
    expect((firstResult.stdout + firstResult.stderr).includes(firstSecret)).toBe(false);
    expect((secondResult.stdout + secondResult.stderr).includes(secondSecret)).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(resolve(root, 'searxng/.env.local')).mode & 0o077).toBe(0);
    }
  }, 10_000);

  it('removes complete multiline quoted application assignments', () => {
    const root = fixture({
      agentEnv: [
        validAgentEnv.trimEnd(),
        'SEARXNG_BASE_URL="https://stale.example.test',
        'stale-base-continuation" # stale base comment',
        "SEARXNG_API_KEY='stale-api-first",
        "stale-api-continuation'",
        'UNRELATED=preserved',
        '',
      ].join('\r\n'),
    });
    expect(run(root, ['scripts/storage-env.sh']).status).toBe(0);

    const result = run(root, ['scripts/searxng-env.sh']);
    const generated = readFileSync(resolve(root, 'agent/.env.development'), 'utf8');
    const values = parse(generated);

    expect(result.status, result.stderr).toBe(0);
    expect(values.SEARXNG_BASE_URL).toBe('http://127.0.0.1:8888');
    expect(values.SEARXNG_API_KEY).toBe('');
    expect(generated.match(/^SEARXNG_BASE_URL=/gm)).toHaveLength(1);
    expect(generated.match(/^SEARXNG_API_KEY=/gm)).toHaveLength(1);
    expect(generated.includes('stale-base-continuation')).toBe(false);
    expect(generated.includes('stale-api-continuation')).toBe(false);
    expect(generated).toContain('UNRELATED=preserved');
    expect(result.stdout + result.stderr).not.toContain('stale-base-continuation');
    expect(result.stdout + result.stderr).not.toContain('stale-api-continuation');
  });

  it('ignores escaped delimiters until multiline single and backtick assignments close', () => {
    const root = fixture({
      agentEnv: [
        validAgentEnv.trimEnd(),
        "SEARXNG_BASE_URL='https://stale.example.test/escaped\\'delimiter",
        "stale-single-continuation' # stale single comment",
        'SEARXNG_API_KEY=`stale\\`delimiter',
        'stale-backtick-continuation`',
        'UNRELATED=preserved-after-escaped-values',
        '',
      ].join('\n'),
    });
    expect(run(root, ['scripts/storage-env.sh']).status).toBe(0);

    const result = run(root, ['scripts/searxng-env.sh']);
    const generated = readFileSync(resolve(root, 'agent/.env.development'), 'utf8');

    expect(result.status, result.stderr).toBe(0);
    expect(generated.includes('stale-single-continuation')).toBe(false);
    expect(generated.includes('stale-backtick-continuation')).toBe(false);
    expect(generated).toContain('UNRELATED=preserved-after-escaped-values');
    expect(result.stdout + result.stderr).not.toContain('stale-single-continuation');
    expect(result.stdout + result.stderr).not.toContain('stale-backtick-continuation');
  });

  it('rejects an unterminated target assignment without changing generated state', () => {
    const root = fixture();
    expect(run(root, ['scripts/storage-env.sh']).status).toBe(0);
    expect(run(root, ['scripts/searxng-env.sh']).status).toBe(0);

    const localPath = resolve(root, 'searxng/.env.local');
    const localContent = readFileSync(localPath, 'utf8');
    const localValues = parse(localContent);
    const sourcePath = resolve(root, 'agent/.env');
    const sourceContent = readFileSync(sourcePath, 'utf8');
    const generatedPath = resolve(root, 'agent/.env.development');
    appendFileSync(generatedPath, [
      'SEARXNG_API_KEY="unterminated-target-value',
      'UNRELATED=must-remain-after-invalid-assignment',
      '',
    ].join('\n'));
    const generatedContent = readFileSync(generatedPath, 'utf8');

    const result = run(root, ['scripts/searxng-env.sh']);

    expect(result.status).not.toBe(0);
    expect(result.stderr.split(invalidSearxngAssignmentError)).toHaveLength(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.includes('unterminated-target-value')).toBe(false);
    expect(result.stderr.includes('must-remain-after-invalid-assignment')).toBe(false);
    expect(result.stderr.includes(localValues.SEARXNG_SECRET!)).toBe(false);
    expect(result.stderr.includes(localValues.SEARXNG_CONFIG_HASH!)).toBe(false);
    expect(readFileSync(sourcePath, 'utf8') === sourceContent).toBe(true);
    expect(readFileSync(generatedPath, 'utf8') === generatedContent).toBe(true);
    expect(readFileSync(localPath, 'utf8') === localContent).toBe(true);
  });

  it('rejects service-only values in retained agent content without mutation', () => {
    const root = fixture({ agentEnv: null });
    expect(run(root, ['scripts/searxng-env.sh']).status).toBe(0);

    const localPath = resolve(root, 'searxng/.env.local');
    const localContent = readFileSync(localPath, 'utf8');
    const localValues = parse(localContent);
    const sourcePath = resolve(root, 'agent/.env');
    writeFileSync(sourcePath, [
      validAgentEnv.trimEnd(),
      `UNRELATED_SECRET=${localValues.SEARXNG_SECRET}`,
      `# retained fingerprint ${localValues.SEARXNG_CONFIG_HASH}`,
      '',
    ].join('\n'));
    expect(run(root, ['scripts/storage-env.sh']).status).toBe(0);
    const sourceContent = readFileSync(sourcePath, 'utf8');
    const generatedPath = resolve(root, 'agent/.env.development');
    const generatedContent = readFileSync(generatedPath, 'utf8');

    const result = run(root, ['scripts/searxng-env.sh']);

    expect(result.status).not.toBe(0);
    expect(result.stderr.split(leakedSearxngValueError)).toHaveLength(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.includes(localValues.SEARXNG_SECRET!)).toBe(false);
    expect(result.stderr.includes(localValues.SEARXNG_CONFIG_HASH!)).toBe(false);
    expect(readFileSync(sourcePath, 'utf8') === sourceContent).toBe(true);
    expect(readFileSync(generatedPath, 'utf8') === generatedContent).toBe(true);
    expect(readFileSync(localPath, 'utf8') === localContent).toBe(true);
  });

  it('does not create an agent development environment without an agent source', () => {
    const root = fixture({ agentEnv: null });
    const result = run(root, ['scripts/searxng-env.sh']);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(resolve(root, 'searxng/.env.local'))).toBe(true);
    expect(existsSync(resolve(root, 'agent/.env.development'))).toBe(false);
  });
});

describe('development launcher', () => {
  it('checks Docker Compose before generating Garage state', () => {
    const root = fixture();
    const result = runDev(root, { COMPOSE_AVAILABLE: '0' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Docker Compose is required');
    expect(existsSync(resolve(root, 'storage/.env.local'))).toBe(false);
  });

  it('validates generated Compose config before inspecting or starting Garage', () => {
    const root = fixture({ tmux: true });
    const success = runDev(root);
    const successCalls = readFileSync(resolve(root, 'mock-log/docker'), 'utf8').split('\n');
    const configIndex = successCalls.findIndex((call) => call.includes('config --quiet'));
    const psIndex = successCalls.findIndex((call) => call.includes('ps -q garage'));
    const upIndex = successCalls.findIndex((call) => call.includes(' up '));

    expect(success.status, success.stderr).toBe(0);
    expect(configIndex).toBeGreaterThan(-1);
    expect(configIndex).toBeLessThan(psIndex);
    expect(configIndex).toBeLessThan(upIndex);

    const failingRoot = fixture();
    const secret = 'must-not-appear-in-output';
    expect(run(failingRoot, ['scripts/storage-env.sh']).status).toBe(0);
    const storageEnvPath = resolve(failingRoot, 'storage/.env.local');
    const generatedStorageEnv = readFileSync(storageEnvPath, 'utf8').replace(
      /^GARAGE_SECRET_ACCESS_KEY=.*$/m,
      `GARAGE_SECRET_ACCESS_KEY=${secret}`,
    );
    writeFileSync(storageEnvPath, generatedStorageEnv);
    const failed = runDev(failingRoot, { COMPOSE_CONFIG_FAIL: '1' });
    const failedCalls = readFileSync(resolve(failingRoot, 'mock-log/docker'), 'utf8');

    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('Garage Compose configuration is invalid');
    expect(existsSync(resolve(failingRoot, 'storage/.env.local'))).toBe(true);
    expect(existsSync(resolve(failingRoot, 'storage/.garage/garage.toml'))).toBe(true);
    expect(failedCalls).toContain('config --quiet');
    expect(failedCalls).not.toContain('ps -q garage');
    expect(failedCalls).not.toContain(' up ');
    expect(`${failed.stdout}${failed.stderr}`).not.toContain(secret);
  });

  it('reports occupied Garage ports before Compose startup', async () => {
    const root = fixture();
    const holder = spawn(process.execPath, [
      '-e',
      "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));",
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise<number>((resolvePort, reject) => {
      holder.once('error', reject);
      holder.once('exit', (code) => reject(new Error(`Port holder exited early with ${code}`)));
      holder.stdout.once('data', (data) => resolvePort(Number(String(data).trim())));
    });

    try {
      const result = runDev(root, { CHEKKU_GARAGE_PORTS: String(port), GARAGE_RUNNING: '0' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`Garage port conflict: ${port}`);
      expect(readFileSync(resolve(root, 'mock-log/docker'), 'utf8')).not.toContain(' up ');
    } finally {
      holder.kill();
    }
  });

  it('bounds readiness by elapsed time and reports the configured duration', () => {
    const hugeInterval = '18446744073709551615';
    const root = fixture({ rejectedSleep: hugeInterval });
    const startedAt = Date.now();
    const result = runDev(root, {
      CHEKKU_NO_TMUX: '1',
      CHEKKU_READY_INTERVAL_SECONDS: hugeInterval,
      CHEKKU_READY_TIMEOUT_SECONDS: '1',
      DOCKER_HEALTH: 'starting',
    });
    const elapsedMs = Date.now() - startedAt;
    const calls = readFileSync(resolve(root, 'mock-log/docker'), 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Garage did not become healthy within 1 second.');
    expect(elapsedMs).toBeLessThan(3_000);
    expect(calls.match(/^inspect /gm)?.length).toBeGreaterThanOrEqual(1);
  });

  it('normalizes leading-zero decimal durations before arithmetic and output', () => {
    const healthyRoot = fixture({ tmux: true });
    const startedAt = Date.now();
    const healthy = runDev(healthyRoot, {
      CHEKKU_READY_TIMEOUT_SECONDS: '030',
      CHEKKU_READY_INTERVAL_SECONDS: '099',
      DOCKER_HEALTH_ON_SECOND: '1',
    });

    expect(healthy.status, healthy.stderr).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_000);
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    expect(readFileSync(resolve(healthyRoot, 'mock-log/inspect-count'), 'utf8')).toBe('2');

    const timeoutRoot = fixture();
    const timedOut = runDev(timeoutRoot, {
      CHEKKU_NO_TMUX: '1',
      CHEKKU_READY_TIMEOUT_SECONDS: '0001',
      CHEKKU_READY_INTERVAL_SECONDS: '099',
      DOCKER_HEALTH: 'starting',
    });

    expect(timedOut.status).not.toBe(0);
    expect(timedOut.stderr).toContain('Garage did not become healthy within 1 second.');
    expect(timedOut.stderr).not.toContain('0001');
  }, 12_000);

  it.each(['ps', 'inspect'])('bounds hanging Docker %s process trees without orphans', (command) => {
    const root = fixture();
    const startedAt = Date.now();
    const result = runDev(root, {
      CHEKKU_NO_TMUX: '1',
      CHEKKU_READY_TIMEOUT_SECONDS: '2',
      HANG_DOCKER_COMMAND: command,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Docker health command timed out');
    expect(elapsedMs).toBeLessThan(process.platform === 'win32' ? 5_000 : 3_500);
    expect(existsSync(resolve(root, 'mock-log/orphan-finished'))).toBe(false);
    const orphanPid = readFileSync(resolve(root, 'mock-log/orphan-pid'), 'utf8').trim();
    const orphanCheck = run(root, ['-c', `! kill -0 ${orphanPid} 2>/dev/null`]);
    expect(orphanCheck.status).toBe(0);
  });

  it('waits for KILL cleanup when a Docker descendant ignores TERM', () => {
    const root = fixture();
    const result = runDev(root, {
      CHEKKU_NO_TMUX: '1',
      CHEKKU_READY_TIMEOUT_SECONDS: '2',
      HANG_DOCKER_COMMAND: 'inspect',
      HANG_DOCKER_SECONDS: '30',
      TERM_RESISTANT_DOCKER_DESCENDANT: '1',
    });
    const orphanPid = readFileSync(resolve(root, 'mock-log/orphan-pid'), 'utf8').trim();
    const orphanGroup = readFileSync(resolve(root, 'mock-log/orphan-group'), 'utf8').trim();

    try {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Docker health command timed out');
      expect(existsSync(resolve(root, 'mock-log/orphan-finished'))).toBe(false);
      const orphanCheck = run(root, ['-c', `! kill -0 ${orphanPid} 2>/dev/null`]);
      expect(orphanCheck.status).toBe(0);
    } finally {
      spawnSync(bash, ['-c', `kill -KILL -- -${orphanGroup} 2>/dev/null || true`]);
    }
  });

  it('launches application processes with exactly five Garage variables', () => {
    const root = fixture({ captureNpmEnv: true });
    const result = runDev(root, {
      CHEKKU_NO_TMUX: '1',
      GARAGE_UNRELATED: 'must-not-reach-apps',
    });
    const expectedNames = [
      'GARAGE_ACCESS_KEY_ID',
      'GARAGE_BUCKET',
      'GARAGE_ENDPOINT',
      'GARAGE_REGION',
      'GARAGE_SECRET_ACCESS_KEY',
    ];
    const storageValues = parse(readFileSync(resolve(root, 'storage/.env.local')));

    expect(result.status, result.stderr).toBe(0);
    for (const role of ['dev_agent', 'dev_client']) {
      const lines = readFileSync(resolve(root, `mock-log/env-${role}`), 'utf8').trim().split('\n');
      expect(lines.map((line) => line.slice(0, line.indexOf('=')))).toEqual(expectedNames);
      for (const line of lines) {
        const separator = line.indexOf('=');
        expect(line.slice(separator + 1)).toBe(storageValues[line.slice(0, separator)]);
      }
    }
  });

  it('force-recreates Garage only after generated config changes', () => {
    const root = fixture({ tmux: true });
    expect(run(root, ['scripts/storage-env.sh']).status).toBe(0);
    expect(runDev(root).status).toBe(0);
    appendFileSync(resolve(root, 'storage/garage.toml.template'), '\n# changed\n');
    expect(runDev(root).status).toBe(0);
    const starts = readFileSync(resolve(root, 'mock-log/docker'), 'utf8')
      .split('\n')
      .filter((line) => line.includes(' up '));

    expect(starts[0]).toContain('up -d garage');
    expect(starts[0]).not.toContain('--force-recreate');
    expect(starts[1]).toContain('up -d --force-recreate garage');
  });

  it('removes partially-created tmux session after pane failure', () => {
    const root = fixture({ tmux: true });
    const result = runDev(root, { TMUX_SPLIT_FAIL: '1' });
    const calls = readFileSync(resolve(root, 'mock-log/tmux'), 'utf8');
    const session = calls.match(/^new-session .* -s (\S+)/m)?.[1];

    expect(result.status).not.toBe(0);
    expect(calls).toContain(`kill-session -t ${session}`);
    expect(existsSync(resolve(root, 'mock-log/tmux-session'))).toBe(false);
  });

  it('terminates fallback npm process groups including descendants', () => {
    const root = fixture({ npm: true });
    const result = runDev(root, { CHEKKU_NO_TMUX: '1' });
    const signals = readFileSync(resolve(root, 'mock-log/signals'), 'utf8');

    expect(result.status).toBe(7);
    expect(signals).toContain('agent-wrapper-term');
    expect(signals).toContain('agent-child-term');
  });

  it('kills a TERM-resistant fallback descendant after bounded grace', () => {
    const root = fixture({ npm: true });
    const startedAt = Date.now();
    const result = runDev(root, {
      CHEKKU_NO_TMUX: '1',
      CHEKKU_TERM_GRACE_SECONDS: '1',
      TERM_RESISTANT_NPM_DESCENDANT: '1',
    });
    const group = readFileSync(resolve(root, 'mock-log/app-group'), 'utf8').trim();
    const child = readFileSync(resolve(root, 'mock-log/app-child'), 'utf8').trim();

    try {
      expect(result.status, result.stderr).toBe(7);
      expect(Date.now() - startedAt).toBeLessThan(4_000);
      expect(run(root, ['-c', `! kill -0 ${child} 2>/dev/null`]).status).toBe(0);
    } finally {
      spawnSync(bash, ['-c', `kill -KILL -- -${group} 2>/dev/null || true`]);
    }
  }, 20_000);
});

describe('committed local runtime', () => {
  it('publishes only the loopback S3 port and keeps Garage internals private', () => {
    const compose = readFileSync(resolve(sourceRoot, 'compose.yaml'), 'utf8');
    const scripts = readFileSync(resolve(sourceRoot, 'scripts/storage-env.sh'), 'utf8');
    const launcher = readFileSync(resolve(sourceRoot, 'scripts/dev.sh'), 'utf8');
    const settings = readFileSync(resolve(sourceRoot, 'searxng/settings.yml'), 'utf8');

    expect(compose).toContain('dxflrs/garage:v2.3.0');
    expect(scripts).toContain('GARAGE_BUCKET=chekku-objects');
    expect(compose).toContain('"127.0.0.1:3900:3900"');
    for (const port of [3901, 3902, 3903]) expect(compose).not.toMatch(new RegExp(`^[^#]*${port}:${port}`, 'm'));
    expect(launcher).toContain('CHEKKU_GARAGE_PORTS:-3900}');
    expect(compose).toMatch(/\.\/storage\/\.garage\/garage\.toml:\/etc\/garage\.toml:ro/);
    expect(compose).toMatch(/garage-metadata:\/var\/lib\/garage\/meta/);
    expect(compose).toMatch(/garage-data:\/var\/lib\/garage\/data/);
    expect(compose).toMatch(/healthcheck:[\s\S]*retries:\s*[1-9]/);
    expect(compose).toContain('docker.io/searxng/searxng:2026.7.18-277d8469c');
    expect(compose).toContain('"127.0.0.1:8888:8080"');
    expect(compose).toMatch(/\.\/searxng\/settings\.yml:\/etc\/searxng\/settings\.yml:ro/);
    expect(compose).toMatch(/searxng-cache:\/var\/cache\/searxng/);
    expect(settings).toMatch(/formats:\s*\r?\n\s*- html\s*\r?\n\s*- json/);
    expect(settings).toMatch(/limiter:\s*false/);
    expect(settings).toMatch(/public_instance:\s*false/);
    expect(settings).toMatch(/image_proxy:\s*false/);
  });

  it('ignores generated credentials, configuration, and data paths', () => {
    const root = fixture();
    expect(spawnSync('git', ['init', '--quiet'], { cwd: root }).status).toBe(0);
    const ignored = spawnSync('git', [
      'check-ignore',
      'storage/.env.local',
      'storage/.garage/garage.toml',
      'storage/.garage-data/x',
      'storage/.garage-meta/x',
      'searxng/.env.local',
    ], { cwd: root, encoding: 'utf8' });

    expect(ignored.status, ignored.stderr).toBe(0);
    expect(ignored.stdout.trim().split(/\r?\n/)).toHaveLength(5);
  });
});
