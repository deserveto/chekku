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

function fixture(options: { tmux?: boolean; npm?: boolean; agentEnv?: string | null } = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'chekku-dev-'));
  fixtures.push(root);
  for (const directory of ['scripts', 'storage', 'agent', 'bin']) mkdirSync(resolve(root, directory));
  for (const path of [
    'scripts/dev.sh',
    'scripts/storage-env.sh',
    'storage/garage.toml.template',
    'compose.yaml',
    '.gitignore',
  ]) {
    copyFileSync(resolve(sourceRoot, path), resolve(root, path));
  }
  if (options.agentEnv !== null) writeFileSync(resolve(root, 'agent/.env'), options.agentEnv ?? validAgentEnv);

  executable(resolve(root, 'bin/docker'), `
echo "$*" >> "$MOCK_LOG/docker"
if [[ "$1" == compose ]]; then
  if [[ "$*" == *" version" ]]; then [[ "\${COMPOSE_AVAILABLE:-1}" == 1 ]]; exit; fi
  if [[ "$*" == *" ps -q garage" ]]; then
    if [[ "\${GARAGE_RUNNING:-1}" == 1 ]]; then printf 'garage-id\\n'; fi
    exit 0
  fi
  if [[ "$*" == *" up "* ]]; then exit 0; fi
fi
if [[ "$1" == inspect ]]; then printf '%s\\n' "\${DOCKER_HEALTH:-healthy}"; fi
`);

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
trap 'printf "agent-wrapper-term\\n" >> "$MOCK_LOG/signals"; wait; exit 0' TERM INT
(
  trap 'printf "agent-child-term\\n" >> "$MOCK_LOG/signals"; exit 0' TERM INT
  while true; do sleep 1; done
) &
printf 'agent-ready\\n' >> "$MOCK_LOG/signals"
wait
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
        'GARAGE_ENDPOINT=stale-endpoint',
        'GARAGE_REGION="stale region"',
        'GARAGE_BUCKET=stale-bucket',
        'GARAGE_ACCESS_KEY_ID=stale-access-key',
        'GARAGE_SECRET_ACCESS_KEY=stale-secret-key',
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
    expect(values.WEB_URL).toBe('http://localhost:3000');
    for (const [name, value] of Object.entries(garageValues)) {
      expect(values[name]).toBe(value);
      expect(generated.match(new RegExp(`^${name}=`, 'gm'))).toHaveLength(1);
      expect(result.stdout).not.toContain(value);
      expect(result.stderr).not.toContain(value);
    }
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

describe('development launcher', () => {
  it('checks Docker Compose before generating Garage state', () => {
    const root = fixture();
    const result = runDev(root, { COMPOSE_AVAILABLE: '0' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Docker Compose is required');
    expect(existsSync(resolve(root, 'storage/.env.local'))).toBe(false);
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

  it('bounds Garage readiness polling', () => {
    const root = fixture();
    const result = runDev(root, {
      CHEKKU_NO_TMUX: '1',
      CHEKKU_READY_INTERVAL_SECONDS: '0',
      DOCKER_HEALTH: 'starting',
    });
    const calls = readFileSync(resolve(root, 'mock-log/docker'), 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Garage did not become healthy within 30 seconds');
    expect(calls.match(/^inspect /gm)).toHaveLength(30);
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
});

describe('committed Garage runtime', () => {
  it('pins Garage, bucket, ports, health bounds, generated config, and persistent volumes', () => {
    const compose = readFileSync(resolve(sourceRoot, 'compose.yaml'), 'utf8');
    const scripts = readFileSync(resolve(sourceRoot, 'scripts/storage-env.sh'), 'utf8');

    expect(compose).toContain('dxflrs/garage:v2.3.0');
    expect(scripts).toContain('GARAGE_BUCKET=chekku-objects');
    for (const port of [3900, 3901, 3902, 3903]) expect(compose).toContain(`"${port}:${port}"`);
    expect(compose).toMatch(/\.\/storage\/\.garage\/garage\.toml:\/etc\/garage\.toml:ro/);
    expect(compose).toMatch(/garage-metadata:\/var\/lib\/garage\/meta/);
    expect(compose).toMatch(/garage-data:\/var\/lib\/garage\/data/);
    expect(compose).toMatch(/healthcheck:[\s\S]*retries:\s*[1-9]/);
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
    ], { cwd: root, encoding: 'utf8' });

    expect(ignored.status, ignored.stderr).toBe(0);
    expect(ignored.stdout.trim().split(/\r?\n/)).toHaveLength(4);
  });
});
