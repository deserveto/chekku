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
import { execSync, spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { parse } from 'dotenv';
import { afterEach, describe, expect, it } from 'vitest';

const sourceRoot = resolve(import.meta.dirname, '..');
// Resolve bash to an absolute path once at module load. On Linux, libuv
// resolves a bare executable name against the CHILD process's PATH, not the
// parent's. Tests that override PATH (e.g. to assert setup-env.sh aborts when
// node is missing) would otherwise fail with ENOENT before bash ever runs.
const bash = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : execSync('command -v bash', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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
const bom = '\uFEFF';
const nbsp = '\u00A0';
const verticalTab = '\u000B';
const formFeed = '\u000C';

// Storage and SearXNG keys whose values are actual secrets (random tokens/keys).
// Public default values like GARAGE_REGION=garage are intentionally excluded so
// that legitimate output (e.g. the file path storage/.garage/garage.toml) is not
// flagged as a leak.
const storageSecretKeyNames = new Set([
  'GARAGE_ACCESS_KEY_ID',
  'GARAGE_SECRET_ACCESS_KEY',
  'GARAGE_RPC_SECRET',
  'GARAGE_ADMIN_TOKEN',
  'GARAGE_METRICS_TOKEN',
]);
const searxngSecretKeyNames = new Set([
  'SEARXNG_SECRET',
  'SEARXNG_CONFIG_HASH',
]);
function isSecretKeyName(name: string): boolean {
  return storageSecretKeyNames.has(name) || searxngSecretKeyNames.has(name);
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
  chmodSync(path, 0o755);
}

function prefixedAssignmentNames(content: string): string[] {
  return Object.keys(parse(content))
    .filter((name) => /^(?:GARAGE|SEARXNG)_/.test(name))
    .sort();
}

function fixture(options: {
  tmux?: boolean;
  npm?: boolean;
  agentEnv?: string | null;
  rejectedSleep?: string;
  captureNpmEnv?: boolean;
  setupEnv?: boolean;
} = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'chekku-dev-'));
  fixtures.push(root);
  for (const directory of ['scripts', 'storage', 'searxng', 'agent', 'client', 'bin']) {
    mkdirSync(resolve(root, directory));
  }
  for (const path of [
    'scripts/dev.sh',
    'scripts/setup-env.sh',
    'storage/garage.toml.template',
    'searxng/settings.yml',
    'compose.yaml',
    '.gitignore',
    'agent/.env.example',
    'client/.env.example',
  ]) {
    copyFileSync(resolve(sourceRoot, path), resolve(root, path));
  }
  if (options.agentEnv !== null) writeFileSync(resolve(root, 'agent/.env'), options.agentEnv ?? validAgentEnv);

  executable(resolve(root, 'bin/docker'), `
echo "$*" >> "$MOCK_LOG/docker"
docker_command="$1"
docker_service=''
if [[ "$1" == compose ]] && [[ "$*" == *" ps -q garage" ]]; then
  docker_command=ps
  docker_service=garage
elif [[ "$1" == compose ]] && [[ "$*" == *" ps -q searxng" ]]; then
  docker_command=ps
  docker_service=searxng
elif [[ "$1" == inspect ]]; then
  case "\${*: -1}" in
    garage-id) docker_service=garage ;;
    searxng-id) docker_service=searxng ;;
  esac
fi
if [[ "\${HANG_DOCKER_COMMAND:-}" == "$docker_command" ]] &&
  [[ "\${HANG_DOCKER_SERVICE:-garage}" == "$docker_service" ]]; then
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
  if [[ "$*" == *" ps -q searxng" ]]; then
    if [[ "\${SEARXNG_RUNNING:-1}" == 1 ]]; then printf 'searxng-id\\n'; fi
    exit 0
  fi
  if [[ "$*" == *" up "* ]]; then
    touch "$MOCK_LOG/start-\${*: -1}"
    exit 0
  fi
fi
if [[ "$1" == inspect ]]; then
  health_name="\${docker_service^^}_DOCKER_HEALTH"
  health="\${!health_name:-\${DOCKER_HEALTH:-healthy}}"
  second_name="\${docker_service^^}_HEALTH_ON_SECOND"
  if [[ "\${!second_name:-0}" == 1 ]]; then
    count=0
    count_file="$MOCK_LOG/inspect-count-$docker_service"
    if [[ -f "$count_file" ]]; then count="$(<"$count_file")"; fi
    count=$((count + 1))
    printf '%s' "$count" > "$count_file"
    if ((count < 2)); then health=starting; else health=healthy; fi
  fi
  printf 'inspect %s %s\\n' "$docker_service" "$health" >> "$MOCK_LOG/timeline"
  printf '%s\\n' "$health"
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
printf 'npm %s\\n' "$role" >> "$MOCK_LOG/timeline"
if [[ "$role" == dev_agent && "\${RELOAD_AGENT_ENV:-0}" == 1 ]]; then
  node - "$MOCK_LOG/env-$role" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const { parse } = require('dotenv');

const values = { ...process.env, ...parse(readFileSync('agent/.env.development')) };
const lines = Object.entries(values)
  .filter(([name]) => /^(?:GARAGE|SEARXNG)_/.test(name) || name === 'WEB_READER_API_KEY')
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([name, value]) => name + '=' + value);
writeFileSync(process.argv[2], lines.join('\\n') + '\\n');
NODE
else
  env | grep -E '^(GARAGE|SEARXNG)_|^WEB_READER_API_KEY=' | sort > "$MOCK_LOG/env-$role"
fi
touch "$MOCK_LOG/ready-$role"
for _ in {1..100}; do
  if [[ -f "$MOCK_LOG/ready-dev_agent" && -f "$MOCK_LOG/ready-dev_client" ]]; then exit 0; fi
  sleep 0.01
done
exit 1
`);
  }

  if (options.setupEnv !== false) {
    runSetup(root, [], '');
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

function runSetup(
  root: string,
  args: string[] = [],
  stdin: string | null = null,
  env: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const log = resolve(root, 'mock-log');
  mkdirSync(log, { recursive: true });
  const path = env.PATH ?? `${resolve(root, 'bin')}${delimiter}${process.env.PATH ?? ''}`;
  return spawnSync(bash, ['scripts/setup-env.sh', ...args], {
    cwd: root,
    encoding: 'utf8',
    ...(stdin !== null ? { input: stdin } : {}),
    timeout: 15_000,
    env: {
      ...process.env,
      ...env,
      MOCK_LOG: log,
      NODE_PATH: resolve(sourceRoot, 'node_modules'),
      PATH: path,
    },
  });
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('development launcher', () => {
  it('checks Docker Compose before generating Garage state', () => {
    const root = fixture({ setupEnv: false });
    const result = runDev(root, { COMPOSE_AVAILABLE: '0' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Docker Compose is required');
    expect(existsSync(resolve(root, 'storage/.env.local'))).toBe(false);
  });

  it('validates generated Compose config before inspecting or starting either service', () => {
    const root = fixture({ tmux: true });
    const success = runDev(root);
    const successCalls = readFileSync(resolve(root, 'mock-log/docker'), 'utf8').split('\n');
    const configIndex = successCalls.findIndex((call) => call.includes('config --quiet'));
    const garagePsIndex = successCalls.findIndex((call) => call.includes('ps -q garage'));
    const searxngPsIndex = successCalls.findIndex((call) => call.includes('ps -q searxng'));
    const garageUpIndex = successCalls.findIndex((call) => call.includes(' up ') && call.endsWith('garage'));
    const searxngUpIndex = successCalls.findIndex((call) => call.includes(' up ') && call.endsWith('searxng'));

    expect(success.status, success.stderr).toBe(0);
    expect(configIndex).toBeGreaterThan(-1);
    for (const serviceIndex of [garagePsIndex, searxngPsIndex, garageUpIndex, searxngUpIndex]) {
      expect(configIndex).toBeLessThan(serviceIndex);
    }
    expect(successCalls).toContain('compose --env-file storage/.env.local ps -q garage');
    expect(successCalls).toContain('compose --env-file storage/.env.local ps -q searxng');
    expect(successCalls.join('\n')).toMatch(/compose .* up -d .*garage/);
    expect(successCalls.join('\n')).toMatch(/compose .* up -d .*searxng/);
    expect(success.stdout).toContain('Garage ready');
    expect(success.stdout).toContain('SearXNG ready');

    const failingRoot = fixture();
    const secret = 'must-not-appear-in-output';
    const storageEnvPath = resolve(failingRoot, 'storage/.env.local');
    const generatedStorageEnv = readFileSync(storageEnvPath, 'utf8').replace(
      /^GARAGE_SECRET_ACCESS_KEY=.*$/m,
      `GARAGE_SECRET_ACCESS_KEY=${secret}`,
    );
    writeFileSync(storageEnvPath, generatedStorageEnv);
    const failed = runDev(failingRoot, { COMPOSE_CONFIG_FAIL: '1' });
    const failedCalls = readFileSync(resolve(failingRoot, 'mock-log/docker'), 'utf8');

    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('Local services Compose configuration is invalid');
    expect(existsSync(resolve(failingRoot, 'storage/.env.local'))).toBe(true);
    expect(existsSync(resolve(failingRoot, 'storage/.garage/garage.toml'))).toBe(true);
    expect(failedCalls).toContain('config --quiet');
    expect(failedCalls).not.toContain('ps -q garage');
    expect(failedCalls).not.toContain('ps -q searxng');
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

  it('reports an occupied SearXNG port before Compose startup', async () => {
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
      const result = runDev(root, { CHEKKU_SEARXNG_PORTS: String(port), SEARXNG_RUNNING: '0' });
      const calls = readFileSync(resolve(root, 'mock-log/docker'), 'utf8');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`SearXNG port conflict: ${port}`);
      expect(calls).toContain('ps -q searxng');
      expect(calls).not.toContain('up -d searxng');
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
      GARAGE_HEALTH_ON_SECOND: '1',
    });

    expect(healthy.status, healthy.stderr).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_000);
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    expect(readFileSync(resolve(healthyRoot, 'mock-log/inspect-count-garage'), 'utf8')).toBe('2');

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

  it.each(['ps', 'inspect'])('bounds hanging SearXNG Docker %s process trees without orphans', (command) => {
    const root = fixture();
    const startedAt = Date.now();
    const result = runDev(root, {
      CHEKKU_NO_TMUX: '1',
      CHEKKU_READY_TIMEOUT_SECONDS: '2',
      HANG_DOCKER_COMMAND: command,
      HANG_DOCKER_SERVICE: 'searxng',
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Docker health command timed out before SearXNG became ready');
    expect(elapsedMs).toBeLessThan(process.platform === 'win32' ? 5_000 : 3_500);
    expect(existsSync(resolve(root, 'mock-log/orphan-finished'))).toBe(false);
    const orphanPid = readFileSync(resolve(root, 'mock-log/orphan-pid'), 'utf8').trim();
    const orphanCheck = run(root, ['-c', `! kill -0 ${orphanPid} 2>/dev/null`]);
    expect(orphanCheck.status).toBe(0);
  });

  it('reports a bounded SearXNG health timeout without launching applications', async () => {
    const root = fixture({ captureNpmEnv: true });
    const resultPromise = runAsync(root, ['scripts/dev.sh'], {
      CHEKKU_NO_TMUX: '1',
      CHEKKU_READY_INTERVAL_SECONDS: '1',
      CHEKKU_READY_TIMEOUT_SECONDS: '1',
      SEARXNG_DOCKER_HEALTH: 'starting',
    });
    await waitForPath(resolve(root, 'mock-log/start-searxng'));
    const startedAt = Date.now();
    const result = await resultPromise;

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SearXNG did not become healthy within 1 second.');
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(existsSync(resolve(root, 'mock-log/ready-dev_agent'))).toBe(false);
    expect(existsSync(resolve(root, 'mock-log/ready-dev_client'))).toBe(false);
  });

  it('does not launch either application until both services are healthy', () => {
    const root = fixture({ captureNpmEnv: true });
    const result = runDev(root, {
      CHEKKU_NO_TMUX: '1',
      CHEKKU_READY_INTERVAL_SECONDS: '1',
      SEARXNG_HEALTH_ON_SECOND: '1',
    });
    const timeline = readFileSync(resolve(root, 'mock-log/timeline'), 'utf8').trim().split('\n');
    const healthyIndex = timeline.lastIndexOf('inspect searxng healthy');
    const firstNpmIndex = timeline.findIndex((line) => line.startsWith('npm '));

    expect(result.status, result.stderr).toBe(0);
    expect(timeline).toContain('inspect searxng starting');
    expect(healthyIndex).toBeGreaterThan(-1);
    expect(firstNpmIndex).toBeGreaterThan(healthyIndex);
  });

  it('keeps generated and reloaded Mastra environments limited to application allowlists', () => {
    const leakedValues = [
      'garage-endpoint-continuation',
      'garage-rpc-first',
      'garage-rpc-continuation',
      'garage-admin-value',
      'garage-rpc-hyphen-value',
      'garage-unrelated-dot-value',
      'garage-colon-continuation',
      'garage-bom-value',
      'garage-nbsp-value',
      'garage-vt-value',
      'searxng-secret-first',
      'searxng-secret-continuation',
      'searxng-config-value',
      'searxng-unrelated-value',
      'searxng-secret-dot-value',
      'searxng-unrelated-colon-value',
      'searxng-colon-continuation',
      'searxng-bom-value',
      'searxng-nbsp-value',
      'searxng-vt-value',
    ];
    const root = fixture({
      captureNpmEnv: true,
      agentEnv: [
        validAgentEnv.trimEnd(),
        'GARAGE_ENDPOINT="garage-endpoint-first',
        'garage-endpoint-continuation"',
        "GARAGE_RPC_SECRET='garage-rpc-first",
        "garage-rpc-continuation'",
        'GARAGE_ADMIN_TOKEN=garage-admin-value',
        'GARAGE_UNRELATED=$(touch "$MOCK_LOG/source-executed")',
        'GARAGE_RPC-SECRET=garage-rpc-hyphen-value',
        'GARAGE_UNRELATED.ALT=garage-unrelated-dot-value',
        'GARAGE_COLON.ALT: "garage-colon-first',
        'garage-colon-continuation"',
        `${bom}GARAGE_BOM.SECRET=garage-bom-value`,
        `${nbsp}GARAGE_NBSP.SECRET${nbsp}=${nbsp}garage-nbsp-value`,
        `${verticalTab}GARAGE_VT.SECRET:${formFeed}garage-vt-value`,
        'SEARXNG_BASE_URL=https://stale-searxng.example.test',
        'SEARXNG_API_KEY=stale-api-key',
        'SEARXNG_SECRET="searxng-secret-first',
        'searxng-secret-continuation"',
        'SEARXNG_CONFIG_HASH=searxng-config-value',
        'SEARXNG_UNRELATED=searxng-unrelated-value',
        'SEARXNG_SECRET.ALT=searxng-secret-dot-value',
        'SEARXNG_UNRELATED: searxng-unrelated-colon-value',
        'SEARXNG_COLON.ALT: "searxng-colon-first',
        'searxng-colon-continuation"',
        `${bom}SEARXNG_BOM.SECRET=searxng-bom-value`,
        `${nbsp}SEARXNG_NBSP.SECRET${nbsp}=${nbsp}searxng-nbsp-value`,
        `${verticalTab}SEARXNG_VT.SECRET:${formFeed}searxng-vt-value`,
        `${nbsp}NON-SERVICE.NBSP${nbsp}=${nbsp}preserved-end-to-end-nbsp`,
        `${verticalTab}NON-SERVICE.VT:${formFeed}preserved-end-to-end-vt`,
        'NON-SERVICE.KEY: preserved-colon-value',
        'UNRELATED=preserved-end-to-end',
        '',
      ].join('\n'),
    });
    const expectedAgentNames = [
      'GARAGE_ACCESS_KEY_ID',
      'GARAGE_BUCKET',
      'GARAGE_ENDPOINT',
      'GARAGE_REGION',
      'GARAGE_SECRET_ACCESS_KEY',
      'SEARXNG_API_KEY',
      'SEARXNG_BASE_URL',
    ];
    const expectedClientNames = expectedAgentNames.slice(0, 5);

    const generated = readFileSync(resolve(root, 'agent/.env.development'), 'utf8');
    expect(prefixedAssignmentNames(generated)).toEqual(expectedAgentNames);
    expect(generated).toContain('NON-SERVICE.KEY: preserved-colon-value');
    expect(generated).toContain(`${nbsp}NON-SERVICE.NBSP${nbsp}=${nbsp}preserved-end-to-end-nbsp`);
    expect(generated).toContain(`${verticalTab}NON-SERVICE.VT:${formFeed}preserved-end-to-end-vt`);
    expect(generated).toContain('UNRELATED=preserved-end-to-end');

    const result = runDev(root, { CHEKKU_NO_TMUX: '1', RELOAD_AGENT_ENV: '1' });
    const agentCapture = readFileSync(resolve(root, 'mock-log/env-dev_agent'), 'utf8');
    const clientCapture = readFileSync(resolve(root, 'mock-log/env-dev_client'), 'utf8');

    expect(result.status, result.stderr).toBe(0);
    expect(prefixedAssignmentNames(agentCapture)).toEqual(expectedAgentNames);
    expect(prefixedAssignmentNames(clientCapture)).toEqual(expectedClientNames);
    for (const leakedValue of leakedValues) {
      expect(generated).not.toContain(leakedValue);
      expect(agentCapture).not.toContain(leakedValue);
      expect(clientCapture).not.toContain(leakedValue);
      expect(result.stdout + result.stderr).not.toContain(leakedValue);
    }
    expect(existsSync(resolve(root, 'mock-log/source-executed'))).toBe(false);
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

  it('isolates exact Garage, SearXNG, and Web Reader variables by application role', () => {
    const root = fixture({ captureNpmEnv: true });
    const result = runDev(root, {
      CHEKKU_NO_TMUX: '1',
      GARAGE_UNRELATED: 'must-not-reach-apps',
      SEARXNG_SECRET: 'must-not-reach-apps',
      SEARXNG_CONFIG_HASH: 'must-not-reach-apps',
      SEARXNG_UNRELATED: 'must-not-reach-apps',
      WEB_READER_API_KEY: 'must-reach-agent-only',
    });
    const agentNames = [
      'GARAGE_ACCESS_KEY_ID',
      'GARAGE_BUCKET',
      'GARAGE_ENDPOINT',
      'GARAGE_REGION',
      'GARAGE_SECRET_ACCESS_KEY',
      'SEARXNG_API_KEY',
      'SEARXNG_BASE_URL',
      'WEB_READER_API_KEY',
    ];
    const clientNames = [
      'GARAGE_ACCESS_KEY_ID',
      'GARAGE_BUCKET',
      'GARAGE_ENDPOINT',
      'GARAGE_REGION',
      'GARAGE_SECRET_ACCESS_KEY',
    ];
    const storageValues = parse(readFileSync(resolve(root, 'storage/.env.local')));
    const searxngValues = parse(readFileSync(resolve(root, 'searxng/.env.local')));
    const expectedValues = {
      ...storageValues,
      ...searxngValues,
      WEB_READER_API_KEY: 'must-reach-agent-only',
    };

    expect(result.status, result.stderr).toBe(0);
    for (const [role, expectedNames] of [
      ['dev_agent', agentNames],
      ['dev_client', clientNames],
    ] as const) {
      const lines = readFileSync(resolve(root, `mock-log/env-${role}`), 'utf8').trim().split('\n');
      expect(lines.map((line) => line.slice(0, line.indexOf('=')))).toEqual(expectedNames);
      for (const line of lines) {
        const separator = line.indexOf('=');
        expect(line.slice(separator + 1)).toBe(expectedValues[line.slice(0, separator)]);
      }
    }
  });

  it('strips the Web Reader key from only the tmux client process', () => {
    const root = fixture({ tmux: true });
    const result = runDev(root, { WEB_READER_API_KEY: 'must-reach-agent-only' });
    const calls = readFileSync(resolve(root, 'mock-log/tmux'), 'utf8').split('\n');
    const agentCall = calls.find((line) => line.startsWith('new-session '));
    const clientCall = calls.find((line) => line.startsWith('split-window '));

    expect(result.status, result.stderr).toBe(0);
    expect(agentCall).not.toContain('unset WEB_READER_API_KEY');
    expect(clientCall).toContain('unset WEB_READER_API_KEY');
  });

  it('propagates the Web Reader key from agent env through setup only to the agent', () => {
    const root = fixture({ captureNpmEnv: true });
    const agentEnvPath = resolve(root, 'agent/.env');
    const agentEnv = readFileSync(agentEnvPath, 'utf8').replace(
      /^WEB_READER_API_KEY=.*$/m,
      'WEB_READER_API_KEY=reader-from-agent-env',
    );
    writeFileSync(agentEnvPath, agentEnv);

    const setup = runSetup(root, [], '');
    const result = runDev(root, { CHEKKU_NO_TMUX: '1', RELOAD_AGENT_ENV: '1' });
    const generated = parse(readFileSync(resolve(root, 'agent/.env.development'), 'utf8'));
    const agentCapture = readFileSync(resolve(root, 'mock-log/env-dev_agent'), 'utf8');
    const clientCapture = readFileSync(resolve(root, 'mock-log/env-dev_client'), 'utf8');

    expect(setup.status, setup.stderr).toBe(0);
    expect(result.status, result.stderr).toBe(0);
    expect(generated.WEB_READER_API_KEY).toBe('reader-from-agent-env');
    expect(agentCapture).toContain('WEB_READER_API_KEY=reader-from-agent-env');
    expect(clientCapture).not.toContain('WEB_READER_API_KEY');
  });

  it('force-recreates Garage only after generated config changes', () => {
    const root = fixture({ tmux: true });
    expect(runDev(root).status).toBe(0);
    expect(runDev(root).status).toBe(0);
    appendFileSync(resolve(root, 'storage/.garage/garage.toml'), '\n# changed\n');
    expect(runDev(root).status).toBe(0);
    const starts = readFileSync(resolve(root, 'mock-log/docker'), 'utf8')
      .split('\n')
      .filter((line) => line.includes(' up '));

    expect(starts[0]).toContain('up -d --force-recreate garage');
    expect(starts[1]).toContain('up -d searxng');
    expect(starts[1]).not.toContain('--force-recreate');
    expect(starts[2]).toContain('up -d garage');
    expect(starts[2]).not.toContain('--force-recreate');
    expect(starts[3]).toContain('up -d searxng');
    expect(starts[3]).not.toContain('--force-recreate');
    expect(starts[4]).toContain('up -d --force-recreate garage');
    expect(starts[5]).toContain('up -d searxng');
  }, 30_000);

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

describe('dev.sh integration with setup-env.sh', () => {
  it('aborts with an actionable message when storage/.env.local is missing', () => {
    const root = fixture();
    writeFileSync(resolve(root, 'agent/.env'), validAgentEnv);
    rmSync(resolve(root, 'storage/.env.local'), { force: true });
    const result = runDev(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Run scripts/setup-env.sh first');
  }, 20_000);

  it('writes .applied-hash after garage becomes healthy on first run', () => {
    const root = fixture({ captureNpmEnv: true });
    runSetup(root);
    expect(existsSync(resolve(root, 'storage/.garage/.applied-hash'))).toBe(false);
    const result = runDev(root, { CHEKKU_NO_TMUX: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(resolve(root, 'storage/.garage/.applied-hash'))).toBe(true);
  }, 20_000);

  it('does not force-recreate garage when hash matches applied hash', () => {
    const root = fixture({ captureNpmEnv: true });
    const tomlPath = resolve(root, 'storage/.garage/garage.toml');
    const tomlHashResult = spawnSync(bash, ['-c', `sha256sum "${tomlPath.replace(/\\/g, '/')}" | cut -d' ' -f1`], { encoding: 'utf8' });
    const tomlHash = tomlHashResult.stdout.trim();
    writeFileSync(resolve(root, 'storage/.garage/.applied-hash'), tomlHash);
    runDev(root, { CHEKKU_NO_TMUX: '1' });
    const dockerLog = readFileSync(resolve(root, 'mock-log/docker'), 'utf8');
    const upLines = dockerLog.split(/\r?\n/).filter((line) => line.includes(' up '));
    expect(upLines.length).toBeGreaterThan(0);
    for (const line of upLines) {
      expect(line).not.toContain('--force-recreate');
    }
  }, 20_000);
});

describe('committed local runtime', () => {
  it('publishes only the loopback S3 port and keeps Garage internals private', () => {
    const compose = readFileSync(resolve(sourceRoot, 'compose.yaml'), 'utf8');
    const scripts = readFileSync(resolve(sourceRoot, 'scripts/setup-env.sh'), 'utf8');
    const launcher = readFileSync(resolve(sourceRoot, 'scripts/dev.sh'), 'utf8');
    const settings = readFileSync(resolve(sourceRoot, 'searxng/settings.yml'), 'utf8');

    expect(compose).toContain('dxflrs/garage:v2.3.0');
    expect(scripts).toMatch(/GARAGE_BUCKET=.*chekku-objects/);
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

describe('setup-env.sh', () => {
  it('runs and exits 0 on a clean fixture', () => {
    const root = fixture();
    const result = runSetup(root);
    expect(result.status, result.stderr).toBe(0);
  });

  describe('prerequisites and bootstrap', () => {
    it('copies agent/.env.example to agent/.env with mode 0600 when missing', () => {
      const root = fixture({ setupEnv: false, agentEnv: null });
      expect(existsSync(resolve(root, 'agent/.env'))).toBe(false);
      const result = runSetup(root);
      expect(result.status, result.stderr).toBe(0);
      const envPath = resolve(root, 'agent/.env');
      expect(existsSync(envPath)).toBe(true);
      expect(readFileSync(envPath, 'utf8')).toBe(
        readFileSync(resolve(sourceRoot, 'agent/.env.example'), 'utf8'),
      );
      if (process.platform !== 'win32') {
        expect(statSync(envPath).mode & 0o077).toBe(0);
      }
    });

    it('copies client/.env.example to client/.env.local with mode 0600 when missing', () => {
      const root = fixture();
      const result = runSetup(root);
      expect(result.status, result.stderr).toBe(0);
      const envPath = resolve(root, 'client/.env.local');
      expect(existsSync(envPath)).toBe(true);
      expect(readFileSync(envPath, 'utf8')).toBe(
        readFileSync(resolve(sourceRoot, 'client/.env.example'), 'utf8'),
      );
      if (process.platform !== 'win32') {
        expect(statSync(envPath).mode & 0o077).toBe(0);
      }
    });

    it('preserves an existing agent/.env in sync mode', () => {
      const root = fixture();
      const original = 'LLM_API_KEY=preserved-key\nPORT=4111\n';
      writeFileSync(resolve(root, 'agent/.env'), original);
      const result = runSetup(root, [], '');
      expect(result.status, result.stderr).toBe(0);
      const values = parse(readFileSync(resolve(root, 'agent/.env'), 'utf8'));
      expect(values.LLM_API_KEY).toBe('preserved-key');
      expect(values.PORT).toBe('4111');
    });

    it('aborts when node is missing on PATH', () => {
      const root = fixture({ agentEnv: null });
      const emptyPath = resolve(root, 'empty-bin');
      mkdirSync(emptyPath, { recursive: true });
      const result = runSetup(root, [], null, { PATH: emptyPath });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('node');
    });
  });

  describe('storage/.env.local generation', () => {
    it('creates private stable random Garage credentials', () => {
      const root = fixture();
      const first = runSetup(root);
      const envPath = resolve(root, 'storage/.env.local');
      const envContent = readFileSync(envPath, 'utf8');
      const values = parse(envContent);

      expect(first.status, first.stderr).toBe(0);
      expect(values.GARAGE_ENDPOINT).toBe('http://127.0.0.1:3900');
      expect(values.GARAGE_REGION).toBe('garage');
      expect(values.GARAGE_BUCKET).toBe('chekku-objects');
      expect(values.GARAGE_ACCESS_KEY_ID).toMatch(/^GK[A-F0-9]{24}$/);
      expect(values.GARAGE_SECRET_ACCESS_KEY).toMatch(/^[0-9a-f]{64}$/);
      expect(values.GARAGE_RPC_SECRET).toMatch(/^[0-9a-f]{64}$/);
      expect(values.GARAGE_ADMIN_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(values.GARAGE_METRICS_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // Second run is a no-op.
      const second = runSetup(root);
      expect(second.status, second.stderr).toBe(0);
      expect(readFileSync(envPath, 'utf8')).toBe(envContent);

      if (process.platform !== 'win32') {
        expect(statSync(envPath).mode & 0o077).toBe(0);
      }
      // Secret values never appear in stdout/stderr.
      for (const [name, value] of Object.entries(values)) {
        if (!value || !storageSecretKeyNames.has(name)) continue;
        expect(first.stdout).not.toContain(value);
        expect(first.stderr).not.toContain(value);
      }
    });

    it('regenerates only when the file is missing or invalid', () => {
      const root = fixture();
      runSetup(root);
      const envPath = resolve(root, 'storage/.env.local');
      const before = readFileSync(envPath, 'utf8');
      const beforeValues = parse(before);
      // Tamper: drop one required line.
      const tampered = before.replace(/^GARAGE_ADMIN_TOKEN=.*\n/m, '');
      writeFileSync(envPath, tampered);
      const result = runSetup(root);
      expect(result.status, result.stderr).toBe(0);
      const afterValues = parse(readFileSync(envPath, 'utf8'));
      expect(afterValues.GARAGE_ADMIN_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(afterValues.GARAGE_ADMIN_TOKEN).not.toBe(beforeValues.GARAGE_ADMIN_TOKEN);
      // Merge-and-fill preserves the other existing values verbatim.
      expect(afterValues.GARAGE_BUCKET).toBe('chekku-objects');
      expect(afterValues.GARAGE_RPC_SECRET).toBe(beforeValues.GARAGE_RPC_SECRET);
      expect(afterValues.GARAGE_SECRET_ACCESS_KEY).toBe(beforeValues.GARAGE_SECRET_ACCESS_KEY);
      expect(afterValues.GARAGE_ACCESS_KEY_ID).toBe(beforeValues.GARAGE_ACCESS_KEY_ID);
      expect(afterValues.GARAGE_METRICS_TOKEN).toBe(beforeValues.GARAGE_METRICS_TOKEN);
    });

    it('preserves user-customized GARAGE_BUCKET when regenerating after another key becomes invalid', () => {
      const root = fixture();
      runSetup(root);
      const envPath = resolve(root, 'storage/.env.local');
      const tampered = readFileSync(envPath, 'utf8')
        .replace(/^GARAGE_BUCKET=.*\n/m, 'GARAGE_BUCKET=my-custom-bucket\n')
        .replace(/^GARAGE_ADMIN_TOKEN=.*\n/m, '');
      writeFileSync(envPath, tampered);
      const result = runSetup(root);
      expect(result.status, result.stderr).toBe(0);
      const after = parse(readFileSync(envPath, 'utf8'));
      expect(after.GARAGE_BUCKET).toBe('my-custom-bucket');
      expect(after.GARAGE_ADMIN_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  describe('garage.toml rendering', () => {
    it('renders storage/.garage/garage.toml from the tracked template', () => {
      const root = fixture();
      const result = runSetup(root);
      const tomlPath = resolve(root, 'storage/.garage/garage.toml');
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(tomlPath)).toBe(true);
      const toml = readFileSync(tomlPath, 'utf8');
      const storageValues = parse(readFileSync(resolve(root, 'storage/.env.local'), 'utf8'));
      expect(toml).toContain(`rpc_secret = "${storageValues.GARAGE_RPC_SECRET}"`);
      expect(toml).toContain(`s3_region = "${storageValues.GARAGE_REGION}"`);
      expect(toml).toContain(`admin_token = "${storageValues.GARAGE_ADMIN_TOKEN}"`);
      expect(toml).toContain(`metrics_token = "${storageValues.GARAGE_METRICS_TOKEN}"`);
      expect(toml).not.toContain('${GARAGE_');
      if (process.platform !== 'win32') {
        expect(statSync(tomlPath).mode & 0o077).toBe(0);
      }
    });

    it('keeps the same inode when the rendered output is unchanged', () => {
      const root = fixture();
      runSetup(root);
      const tomlPath = resolve(root, 'storage/.garage/garage.toml');
      const inodeBefore = statSync(tomlPath).ino;
      runSetup(root);
      if (process.platform !== 'win32') {
        expect(statSync(tomlPath).ino).toBe(inodeBefore);
      }
    });
  });

  describe('searxng/.env.local generation', () => {
    it('creates the local searxng env with the expected shape', () => {
      const root = fixture();
      const result = runSetup(root);
      const envPath = resolve(root, 'searxng/.env.local');
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(envPath)).toBe(true);
      const values = parse(readFileSync(envPath, 'utf8'));
      expect(values.SEARXNG_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(values.SEARXNG_CONFIG_HASH).toMatch(/^[a-f0-9]{64}$/);
      expect(values.SEARXNG_BASE_URL).toBe('http://127.0.0.1:8888');
      expect(values.SEARXNG_API_KEY).toBe('');
      if (process.platform !== 'win32') {
        expect(statSync(envPath).mode & 0o077).toBe(0);
      }
    });

    it('preserves SEARXNG_SECRET and updates SEARXNG_CONFIG_HASH when settings change', () => {
      const root = fixture();
      runSetup(root);
      const envPath = resolve(root, 'searxng/.env.local');
      const before = parse(readFileSync(envPath, 'utf8'));
      // Simulate a settings change.
      writeFileSync(
        resolve(root, 'searxng/settings.yml'),
        readFileSync(resolve(root, 'searxng/settings.yml'), 'utf8') + '\n# changed\n',
      );
      const result = runSetup(root);
      expect(result.status, result.stderr).toBe(0);
      const after = parse(readFileSync(envPath, 'utf8'));
      expect(after.SEARXNG_SECRET).toBe(before.SEARXNG_SECRET);
      expect(after.SEARXNG_CONFIG_HASH).not.toBe(before.SEARXNG_CONFIG_HASH);
    });
  });

  describe('agent/.env.development rendering', () => {
    it('writes exactly the five Garage app keys and 2 SearXNG app keys, never service secrets', () => {
      const root = fixture();
      const result = runSetup(root);
      const devPath = resolve(root, 'agent/.env.development');
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(devPath)).toBe(true);
      const generated = readFileSync(devPath, 'utf8');
      const values = parse(generated);
      const storageValues = parse(readFileSync(resolve(root, 'storage/.env.local'), 'utf8'));
      const searxngValues = parse(readFileSync(resolve(root, 'searxng/.env.local'), 'utf8'));

      expect(values.GARAGE_ENDPOINT).toBe(storageValues.GARAGE_ENDPOINT);
      expect(values.GARAGE_REGION).toBe(storageValues.GARAGE_REGION);
      expect(values.GARAGE_BUCKET).toBe(storageValues.GARAGE_BUCKET);
      expect(values.GARAGE_ACCESS_KEY_ID).toBe(storageValues.GARAGE_ACCESS_KEY_ID);
      expect(values.GARAGE_SECRET_ACCESS_KEY).toBe(storageValues.GARAGE_SECRET_ACCESS_KEY);
      expect(values.SEARXNG_BASE_URL).toBe('http://127.0.0.1:8888');
      expect(values.SEARXNG_API_KEY).toBe('');

      const secretNames = ['GARAGE_RPC_SECRET', 'GARAGE_ADMIN_TOKEN', 'GARAGE_METRICS_TOKEN', 'SEARXNG_SECRET', 'SEARXNG_CONFIG_HASH'];
      for (const name of secretNames) {
        const secretValue = searxngValues[name] ?? storageValues[name] ?? '';
        expect(generated).not.toContain(secretValue);
        expect(generated).not.toMatch(new RegExp(`^${name}=`, 'm'));
      }
      if (process.platform !== 'win32') {
        expect(statSync(devPath).mode & 0o077).toBe(0);
      }
    });

    it('removes stale Garage assignments including multiline values', () => {
      const root = fixture();
      writeFileSync(resolve(root, 'agent/.env'), [
        validAgentEnv.trimEnd(),
        'GARAGE_ENDPOINT="stale-endpoint-first',
        'stale-endpoint-second"',
        "export GARAGE_RPC_SECRET='stale-rpc-first",
        "stale-rpc-second'",
        'UNRELATED=preserved',
        '',
      ].join('\r\n'));
      const result = runSetup(root);
      expect(result.status, result.stderr).toBe(0);
      const generated = readFileSync(resolve(root, 'agent/.env.development'), 'utf8');
      expect(generated).toContain('UNRELATED=preserved');
      expect(generated).not.toContain('stale-');
    });

    it('preserves a non-empty user-set SEARXNG_API_KEY from agent/.env into agent/.env.development', () => {
      const root = fixture();
      writeFileSync(
        resolve(root, 'agent/.env'),
        [validAgentEnv.trimEnd(), 'SEARXNG_API_KEY=user-bearer-token', ''].join('\n'),
      );
      const result = runSetup(root);
      expect(result.status, result.stderr).toBe(0);
      const values = parse(readFileSync(resolve(root, 'agent/.env.development'), 'utf8'));
      expect(values.SEARXNG_BASE_URL).toBe('http://127.0.0.1:8888');
      expect(values.SEARXNG_API_KEY).toBe('user-bearer-token');
    });

    it('regenerates a clean development env from the example when agent/.env is removed between runs', () => {
      const root = fixture();
      runSetup(root);
      expect(existsSync(resolve(root, 'agent/.env.development'))).toBe(true);
      rmSync(resolve(root, 'agent/.env'));
      const result = runSetup(root);
      expect(result.status, result.stderr).toBe(0);
      // setup-env.sh's bootstrap recreates agent/.env from .env.example, then render
      // regenerates the dev env.
      expect(existsSync(resolve(root, 'agent/.env.development'))).toBe(true);
      const generated = readFileSync(resolve(root, 'agent/.env.development'), 'utf8');
      for (const name of ['GARAGE_RPC_SECRET', 'GARAGE_ADMIN_TOKEN', 'GARAGE_METRICS_TOKEN', 'SEARXNG_SECRET', 'SEARXNG_CONFIG_HASH']) {
        expect(generated).not.toMatch(new RegExp(`^${name}=`, 'm'));
      }
    });

    it('does not leak secrets into stdout or stderr', () => {
      const root = fixture();
      const result = runSetup(root);
      const storageValues = parse(readFileSync(resolve(root, 'storage/.env.local'), 'utf8'));
      const searxngValues = parse(readFileSync(resolve(root, 'searxng/.env.local'), 'utf8'));
      for (const [name, value] of Object.entries({ ...storageValues, ...searxngValues })) {
        if (!value || !isSecretKeyName(name)) continue;
        expect(result.stdout).not.toContain(value);
        expect(result.stderr).not.toContain(value);
      }
    });
  });

  describe('agent/.env sync against .env.example', () => {
    it('appends missing variables under the sync marker without overwriting existing values', () => {
      const root = fixture();
      writeFileSync(resolve(root, 'agent/.env'), 'LLM_API_KEY=user-supplied\nPORT=4111\n');
      const result = runSetup(root, [], '');
      expect(result.status, result.stderr).toBe(0);
      const synced = readFileSync(resolve(root, 'agent/.env'), 'utf8');
      const values = parse(synced);
      expect(values.LLM_API_KEY).toBe('user-supplied');
      expect(values.PORT).toBe('4111');
      // Variables present in .env.example but not in the original .env must appear.
      const exampleValues = parse(readFileSync(resolve(sourceRoot, 'agent/.env.example'), 'utf8'));
      for (const name of Object.keys(exampleValues)) {
        expect(values[name], `${name} should be present after sync`).toBeDefined();
      }
      expect(synced).toContain('# Added by setup-env.sh (synced from .env.example)');
    });

    it('is idempotent across multiple runs and only writes one marker', () => {
      const root = fixture();
      writeFileSync(resolve(root, 'agent/.env'), 'LLM_API_KEY=user-supplied\n');
      runSetup(root, [], '');
      const firstSync = readFileSync(resolve(root, 'agent/.env'), 'utf8');
      runSetup(root, [], '');
      const secondSync = readFileSync(resolve(root, 'agent/.env'), 'utf8');
      expect(secondSync).toBe(firstSync);
      const markerCount = (secondSync.match(/# Added by setup-env.sh \(synced from \.env\.example\)/g) ?? []).length;
      expect(markerCount).toBe(1);
    });

    it('appends newly-missing variables on their own lines when the marker already exists', () => {
      const root = fixture();
      const marker = '# Added by setup-env.sh (synced from .env.example)';
      writeFileSync(
        resolve(root, 'agent/.env'),
        [
          'LLM_API_KEY=user-supplied',
          '',
          marker,
          'EXISTING_EXTRA=foo',
          '',
        ].join('\n'),
      );
      const result = runSetup(root, [], '');
      expect(result.status, result.stderr).toBe(0);
      const synced = readFileSync(resolve(root, 'agent/.env'), 'utf8');
      const values = parse(synced);
      expect(values.EXISTING_EXTRA).toBe('foo');
      expect(values.PORT).toBe('4111');
      expect(synced).not.toMatch(/fooPORT=/);
      expect(synced).not.toMatch(/EXISTING_EXTRA=foo[A-Z]/);
      for (const line of synced.split(/\r?\n/)) {
        expect((line.match(/=/g) ?? []).length).toBeLessThanOrEqual(1);
      }
    });

    it('preserves CRLF line endings from the source file on sync', () => {
      const root = fixture();
      writeFileSync(
        resolve(root, 'agent/.env'),
        ['LLM_API_KEY=user-supplied', ''].join('\r\n'),
      );
      const result = runSetup(root, [], '');
      expect(result.status, result.stderr).toBe(0);
      const synced = readFileSync(resolve(root, 'agent/.env'), 'utf8');
      expect(synced).toContain('\r\n');
      expect(synced.includes('\n') && !synced.includes('\r\n')).toBe(false);
      const values = parse(synced);
      expect(values.LLM_API_KEY).toBe('user-supplied');
      expect(values.PORT).toBe('4111');
    });

    it('preserves variables that exist in .env but not in .env.example', () => {
      const root = fixture();
      writeFileSync(resolve(root, 'agent/.env'), 'LLM_API_KEY=x\nCUSTOM_USER_VAR=keep-me\n');
      const result = runSetup(root, [], '');
      expect(result.status, result.stderr).toBe(0);
      expect(parse(readFileSync(resolve(root, 'agent/.env'), 'utf8')).CUSTOM_USER_VAR).toBe('keep-me');
    });
  });

  describe('interactive prompts', () => {
    it('skips prompts and leaves required empty when stdin is piped but empty', () => {
      const root = fixture({ agentEnv: null });
      const result = runSetup(root, [], '');
      expect(result.status, result.stderr).toBe(0);
      expect(parse(readFileSync(resolve(root, 'agent/.env'), 'utf8')).LLM_API_KEY ?? '').toBe('');
    });

    it('skips prompts and leaves values empty when stdin is piped (non-TTY)', () => {
      const root = fixture({ agentEnv: null });
      const stdin = ['user-llm-key', '', '', '', '', '', '', '', ''].join('\n') + '\n';
      const result = runSetup(root, [], stdin);
      expect(result.status, result.stderr).toBe(0);
      const values = parse(readFileSync(resolve(root, 'agent/.env'), 'utf8'));
      // Piped non-TTY stdin does NOT drive prompts: the piped 'user-llm-key'
      // is ignored and LLM_API_KEY stays empty (as in .env.example).
      expect(values.LLM_API_KEY ?? '').toBe('');
      // Required-mode prompts emit a stderr warning.
      expect(result.stderr).toContain('LLM_API_KEY');
    });

    it('does not overwrite values that are already present', () => {
      const root = fixture();
      writeFileSync(
        resolve(root, 'agent/.env'),
        [
          'LLM_API_KEY=already-set',
          'LLM_BASE_URL=https://custom.example/v1',
          '',
        ].join('\n'),
      );
      const result = runSetup(root, [], '\n\n\n');
      expect(result.status, result.stderr).toBe(0);
      const values = parse(readFileSync(resolve(root, 'agent/.env'), 'utf8'));
      expect(values.LLM_API_KEY).toBe('already-set');
      expect(values.LLM_BASE_URL).toBe('https://custom.example/v1');
    });
  });

  describe('summary output', () => {
    it('prints a setup summary without leaking secrets', () => {
      const root = fixture({ agentEnv: null });
      const stdin = ['user-llm-key', '', '', '', '', '', '', '', ''].join('\n') + '\n';
      const result = runSetup(root, [], stdin);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Setup complete.');
      expect(result.stdout).toContain('Files generated:');
      expect(result.stdout).toContain('storage/.env.local');
      expect(result.stdout).toContain('storage/.garage/garage.toml');
      expect(result.stdout).toContain('searxng/.env.local');
      expect(result.stdout).toContain('agent/.env.development');
      expect(result.stdout).toContain('Next step: npm run dev:sh');
      const storageValues = parse(readFileSync(resolve(root, 'storage/.env.local'), 'utf8'));
      const searxngValues = parse(readFileSync(resolve(root, 'searxng/.env.local'), 'utf8'));
      for (const [name, value] of Object.entries({ ...storageValues, ...searxngValues })) {
        if (!value || !isSecretKeyName(name)) continue;
        expect(result.stdout).not.toContain(value);
        expect(result.stderr).not.toContain(value);
      }
      expect(result.stdout).not.toContain('user-llm-key');
    });

    it('lists optional integrations and any still-missing required values', () => {
      const root = fixture({ agentEnv: null });
      const result = runSetup(root, [], '');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('LLM_API_KEY');
      expect(result.stdout).toContain('TELEGRAM_BOT_TOKEN');
      expect(result.stdout).toContain('RESEND_API_KEY');
      expect(result.stdout).toContain('WEB_READER_API_KEY');
      expect(result.stdout).toContain('Rerun npm run setup after editing agent/.env.');
    });
  });
});
