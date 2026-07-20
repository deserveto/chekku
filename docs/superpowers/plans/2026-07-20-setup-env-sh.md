# setup-env.sh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three-script env-generation split (`scripts/dev.sh` sourcing `scripts/storage-env.sh` and `scripts/searxng-env.sh`) with a single user-facing `scripts/setup-env.sh` that bootstraps, syncs, and prompts for missing values, while `dev.sh` becomes a thinner launcher that sources generated files directly.

**Architecture:** One bash script with embedded Node heredocs owns all generation logic. Two implicit modes (initial vs sync) selected by presence of `agent/.env`. Auto-generated secrets (Garage + SearXNG) stay in service-local files; only app-facing keys propagate to `agent/.env.development`. `dev.sh` detects Garage config changes via SHA-256 comparison of the rendered toml against a persisted `.applied-hash` file.

**Tech Stack:** Bash (`set -euo pipefail`, `umask 077`), Node.js `node:crypto` / `node:fs` / `dotenv`, Vitest with `spawnSync(bash)` for shell-script tests.

**Spec:** `docs/superpowers/specs/2026-07-20-setup-env-sh-design.md`

## Global Constraints

Copied verbatim from the spec:

- All generated local files remain gitignored: `agent/.env`, `agent/.env.development`, `client/.env.local`, `storage/.env.local`, `storage/.garage/`, `searxng/.env.local`. The new `storage/.garage/.applied-hash` is also gitignored by virtue of the existing `storage/.garage/` rule.
- Service-only secrets stay out of application environments:
  - `storage/.env.local` keeps `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `GARAGE_METRICS_TOKEN`.
  - `searxng/.env.local` keeps `SEARXNG_SECRET`, `SEARXNG_CONFIG_HASH`.
- Only the five Garage application values (`GARAGE_ENDPOINT`, `GARAGE_REGION`, `GARAGE_BUCKET`, `GARAGE_ACCESS_KEY_ID`, `GARAGE_SECRET_ACCESS_KEY`) propagate to `agent/.env.development`.
- Only `SEARXNG_BASE_URL` and empty `SEARXNG_API_KEY` propagate to `agent/.env.development`.
- The Next.js client process receives zero `SEARXNG_*` values and no Garage service-only secrets.
- Tracked examples (`agent/.env.example`, `client/.env.example`) never contain real secrets.
- Generation writes files with mode `0600` and never logs secret values, endpoints, bearer tokens, request IDs, or upstream bodies.
- Atomic writes via `mktemp` + `mv` are preserved so a partial file is never observed by another process.
- `npm run dev:sh` remains the documented developer entry point.
- Bash via Git Bash is the only supported shell; no PowerShell port.
- AGENTS.md security rules and invariants continue to apply unchanged.

## File Map

| File | Action | Responsibility |
| --- | --- | --- |
| `scripts/setup-env.sh` | create | Single user-facing env bootstrap+sync entry point with embedded Node helpers |
| `scripts/storage-env.sh` | delete | Logic folded into `setup-env.sh` |
| `scripts/searxng-env.sh` | delete | Logic folded into `setup-env.sh` |
| `scripts/dev.sh` | modify | Source generated files; SHA-256 config-change detection |
| `scripts/dev.test.ts` | rewrite | Cover both `setup-env.sh` (ported + new tests) and modified `dev.sh` |
| `package.json` | modify | Add `setup` npm script |
| `README.md` | modify | Quick start, troubleshooting |
| `docs/OPERATIONS.md` | modify | Script references |
| `.env.example` | modify | Comment update only |
| `agent/.env.example` | modify | Comment update only |

## Conventions Used Throughout

- The test runner is Vitest. Tests live in `scripts/dev.test.ts`.
- Each test creates a temp fixture root via the existing `fixture()` helper, copies tracked files in, and invokes `setup-env.sh` via `spawnSync(bash, ['scripts/setup-env.sh'], { cwd: root, env, ... })`.
- The existing `run()`, `runAsync()`, `runDev()`, `fixture()` helpers in `scripts/dev.test.ts` are reused unchanged unless a task explicitly modifies them.
- Every step ends with `npm run test -- scripts/dev.test.ts` (or a narrower filter) and a commit.
- The two embedded Node heredocs from the deleted scripts (Garage generation and `agent/.env.development` rendering; SearXNG generation and propagation) are lifted nearly verbatim into `setup-env.sh`. Lifted code is NOT considered a re-implementation; the test suite continues to assert the same invariants.

---

### Task 1: Test scaffolding and stub script

**Files:**
- Create: `scripts/setup-env.sh`
- Modify: `scripts/dev.test.ts` (rename the existing top `describe` blocks; add a new `describe('setup-env.sh', ...)`)

**Interfaces:**
- Produces: a runnable `scripts/setup-env.sh` that other tasks extend. The test file gains a `runSetup(root, args, env)` helper that later tasks rely on.

- [ ] **Step 1: Create the stub script**

```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
echo "setup-env stub"
```

Write to `scripts/setup-env.sh`.

- [ ] **Step 2: Make the stub executable**

Run:
```bash
chmod +x scripts/setup-env.sh
```

- [ ] **Step 3: Add `runSetup` helper and a smoke test in `scripts/dev.test.ts`**

Add the following helper near the existing `runDev` helper (around line 292):

```typescript
function runSetup(
  root: string,
  args: string[] = [],
  stdin: string | null = null,
  env: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const result = run(root, ['scripts/setup-env.sh', ...args], env);
  if (stdin !== null) {
    // re-run with stdin piped; the existing run() helper does not accept stdin,
    // so wrap it explicitly for setup-env tests
    const log = resolve(root, 'mock-log');
    mkdirSync(log, { recursive: true });
    return spawnSync(bash, ['scripts/setup-env.sh', ...args], {
      cwd: root,
      encoding: 'utf8',
      input: stdin,
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
  return result;
}
```

Add a new `describe('setup-env.sh', () => { ... })` block at the end of the file with one smoke test:

```typescript
describe('setup-env.sh', () => {
  it('runs the stub and exits 0', () => {
    const root = fixture();
    const result = runSetup(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('setup-env stub');
  });
});
```

Also update the `fixture()` helper at lines 92-100 to include `'scripts/setup-env.sh'` in the copied-files array.

- [ ] **Step 4: Run the smoke test**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "runs the stub"
```

Expected: PASS. If it fails because `scripts/storage-env.sh` or `scripts/searxng-env.sh` is also being copied by `fixture()` and they still exist, that is fine — they will be deleted in Task 11.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-env.sh scripts/dev.test.ts
git commit -m "feat(setup-env): add stub script and smoke test"
```

---

### Task 2: Prerequisites and `.env.example` bootstrap

**Files:**
- Modify: `scripts/setup-env.sh`
- Modify: `scripts/dev.test.ts` (extend the `setup-env.sh` describe block)

**Interfaces:**
- Consumes: `agent/.env.example`, `client/.env.example` (tracked).
- Produces: `agent/.env` and `client/.env.local` may now exist after `setup-env.sh` runs, both with mode `0600`.

- [ ] **Step 1: Write failing tests**

Append to the `describe('setup-env.sh', ...)` block:

```typescript
describe('prerequisites and bootstrap', () => {
  it('copies agent/.env.example to agent/.env with mode 0600 when missing', () => {
    const root = fixture();
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
    expect(readFileSync(resolve(root, 'agent/.env'), 'utf8')).toBe(original);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "prerequisites and bootstrap"
```

Expected: FAIL with assertion errors (stub does not copy files).

- [ ] **Step 3: Implement prerequisites and bootstrap in `scripts/setup-env.sh`**

Replace the stub body with:

```bash
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "prerequisites and bootstrap"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-env.sh scripts/dev.test.ts
git commit -m "feat(setup-env): copy env examples with safe mode"
```

---

### Task 3: Generate `storage/.env.local` (Garage secrets)

**Files:**
- Modify: `scripts/setup-env.sh` (append Garage generation block)
- Modify: `scripts/dev.test.ts` (port the relevant cases from the old `describe('storage environment generation', ...)`)

**Interfaces:**
- Produces: `storage/.env.local` with eight keys: `GARAGE_ENDPOINT`, `GARAGE_REGION`, `GARAGE_BUCKET`, `GARAGE_ACCESS_KEY_ID`, `GARAGE_SECRET_ACCESS_KEY`, `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `GARAGE_METRICS_TOKEN`. Mode `0600`. Idempotent.

- [ ] **Step 1: Write failing tests**

Append a new `describe('storage/.env.local generation', () => { ... })` inside `describe('setup-env.sh', ...)`:

```typescript
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
    for (const value of Object.values(values)) {
      expect(first.stdout).not.toContain(value);
      expect(first.stderr).not.toContain(value);
    }
  });

  it('regenerates only missing required keys', () => {
    const root = fixture();
    runSetup(root);
    const envPath = resolve(root, 'storage/.env.local');
    const before = readFileSync(envPath, 'utf8');
    // Tamper: drop one line.
    const tampered = before.replace(/^GARAGE_ADMIN_TOKEN=.*\n/m, '');
    writeFileSync(envPath, tampered);
    const result = runSetup(root);
    expect(result.status, result.stderr).toBe(0);
    const after = readFileSync(envPath, 'utf8');
    expect(parse(after).GARAGE_ADMIN_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Other lines may differ only if the whole file is regenerated; the
    // implementation is allowed to regenerate the whole file when shape is
    // invalid. Assert shape, not value identity.
    expect(parse(after).GARAGE_BUCKET).toBe('chekku-objects');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "storage/.env.local generation"
```

Expected: FAIL (file does not exist).

- [ ] **Step 3: Append Garage generation to `scripts/setup-env.sh`**

Add at the end of the script (before any future prompts / summary):

```bash
STORAGE_ENV_FILE="$ROOT/storage/.env.local"

generate_storage_env() {
  local tmp
  tmp="$(mktemp "${STORAGE_ENV_FILE}.tmp.XXXXXX")"
  chmod 600 "$tmp"
  node >"$tmp" <<'NODE'
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "storage/.env.local generation"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-env.sh scripts/dev.test.ts
git commit -m "feat(setup-env): generate garage storage env idempotently"
```

---

### Task 4: Render `storage/.garage/garage.toml`

**Files:**
- Modify: `scripts/setup-env.sh`
- Modify: `scripts/dev.test.ts`

**Interfaces:**
- Consumes: `storage/.env.local` (`GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `GARAGE_METRICS_TOKEN`, `GARAGE_REGION`).
- Produces: `storage/.garage/garage.toml` with mode `0600`. Atomic write.

- [ ] **Step 1: Write failing tests**

Append to `describe('setup-env.sh', ...)`:

```typescript
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
    expect(statSync(tomlPath).ino).toBe(inodeBefore);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "garage.toml rendering"
```

Expected: FAIL (file does not exist).

- [ ] **Step 3: Append rendering block to `scripts/setup-env.sh`**

Add after the storage-env generation block:

```bash
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "garage.toml rendering"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-env.sh scripts/dev.test.ts
git commit -m "feat(setup-env): render garage.toml from template"
```

---

### Task 5: Generate `searxng/.env.local`

**Files:**
- Modify: `scripts/setup-env.sh`
- Modify: `scripts/dev.test.ts`

**Interfaces:**
- Produces: `searxng/.env.local` with `SEARXNG_SECRET`, `SEARXNG_CONFIG_HASH`, `SEARXNG_BASE_URL`, `SEARXNG_API_KEY`. Mode `0600`. `SEARXNG_SECRET` persisted across runs; `SEARXNG_CONFIG_HASH` regenerated when `searxng/settings.yml` changes.

- [ ] **Step 1: Write failing tests**

Append to `describe('setup-env.sh', ...)`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "searxng/.env.local generation"
```

Expected: FAIL.

- [ ] **Step 3: Append SearXNG generation to `scripts/setup-env.sh`**

```bash
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

const validLine = (name, value, predicate) => predicate(value);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "searxng/.env.local generation"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-env.sh scripts/dev.test.ts
git commit -m "feat(setup-env): generate searxng local env with hash rotation"
```

---

### Task 6: Render `agent/.env.development`

**Files:**
- Modify: `scripts/setup-env.sh`
- Modify: `scripts/dev.test.ts`

**Interfaces:**
- Consumes: `agent/.env`, `storage/.env.local` (five app keys), `searxng/.env.local` (two app keys + service-only secrets to verify absence).
- Produces: `agent/.env.development` with mode `0600`. Contains every non-`GARAGE_`/`SEARXNG_` assignment from `agent/.env` plus exactly the seven app-facing keys. Service-only secrets must NOT appear anywhere in the rendered file.

- [ ] **Step 1: Write failing tests**

Port the most security-critical cases from the existing `describe('storage environment generation', ...)` block. Append to `describe('setup-env.sh', ...)`:

```typescript
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
      expect(generated).not.toContain(searxngValues[name] ?? storageValues[name] ?? '');
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

  it('removes the generated file when agent/.env disappears', () => {
    const root = fixture();
    runSetup(root);
    expect(existsSync(resolve(root, 'agent/.env.development'))).toBe(true);
    rmSync(resolve(root, 'agent/.env'));
    const result = runSetup(root);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(resolve(root, 'agent/.env.development'))).toBe(false);
  });

  it('does not leak secrets into stdout or stderr', () => {
    const root = fixture();
    const result = runSetup(root);
    const storageValues = parse(readFileSync(resolve(root, 'storage/.env.local'), 'utf8'));
    const searxngValues = parse(readFileSync(resolve(root, 'searxng/.env.local'), 'utf8'));
    for (const value of Object.values({ ...storageValues, ...searxngValues })) {
      expect(result.stdout).not.toContain(value);
      expect(result.stderr).not.toContain(value);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "agent/.env.development rendering"
```

Expected: FAIL.

- [ ] **Step 3: Append rendering block to `scripts/setup-env.sh`**

```bash
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
const searxngAssignments = searxngKeys.map((name) => serialize(name, process.env[name] ?? ''));
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

render_agent_dev_env
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "agent/.env.development rendering"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-env.sh scripts/dev.test.ts
git commit -m "feat(setup-env): render agent/.env.development with leak guard"
```

---

### Task 7: Sync `agent/.env` with `agent/.env.example`

**Files:**
- Modify: `scripts/setup-env.sh`
- Modify: `scripts/dev.test.ts`

**Interfaces:**
- Produces: `agent/.env` may gain new variables (from `.env.example`) appended under a single `# Added by setup-env.sh (synced from .env.example)` marker. Existing values are never overwritten. Idempotent across multiple runs.

- [ ] **Step 1: Write failing tests**

Append to `describe('setup-env.sh', ...)`:

```typescript
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

  it('preserves variables that exist in .env but not in .env.example', () => {
    const root = fixture();
    writeFileSync(resolve(root, 'agent/.env'), 'LLM_API_KEY=x\nCUSTOM_USER_VAR=keep-me\n');
    const result = runSetup(root, [], '');
    expect(result.status, result.stderr).toBe(0);
    expect(parse(readFileSync(resolve(root, 'agent/.env'), 'utf8')).CUSTOM_USER_VAR).toBe('keep-me');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "agent/.env sync"
```

Expected: FAIL.

- [ ] **Step 3: Append sync block to `scripts/setup-env.sh`**

Insert immediately after the bootstrap (the `copy_with_mode` calls in Task 2) and before the Garage generation block:

```bash
sync_env_from_example() {
  local source_env="$1"
  local example_env="$2"
  local tmp
  tmp="$(mktemp "${source_env}.tmp.XXXXXX")"
  chmod 600 "$tmp"
  node - "$source_env" "$example_env" "$tmp" <<'NODE'
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

const lines = sourceText.split(/\r?\n/);
if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
const hasMarker = lines.some((line) => line.trim() === marker);
const newBlock = hasMarker ? [] : ['', marker];
for (const name of missing) {
  const value = exampleValues[name] ?? '';
  newBlock.push(`${name}=${value}`);
}
const result = `${lines.join('\n')}${newBlock.join('\n')}\n`;
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "agent/.env sync"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-env.sh scripts/dev.test.ts
git commit -m "feat(setup-env): sync env from example without overwrite"
```

---

### Task 8: Interactive prompts

**Files:**
- Modify: `scripts/setup-env.sh`
- Modify: `scripts/dev.test.ts`

**Interfaces:**
- Consumes: stdin (only when `[[ -t 0 ]]`).
- Produces: writes accepted values back to `agent/.env` via the same atomic Node helper used for sync.

- [ ] **Step 1: Write failing tests**

Append to `describe('setup-env.sh', ...)`:

```typescript
describe('interactive prompts', () => {
  it('skips prompts and leaves required empty when stdin is piped but empty', () => {
    const root = fixture();
    // Force the script to treat stdin as a TTY by setting CHEKKU_SETUP_FORCE_TTY=1
    // is intentionally NOT supported; the script must skip prompts when stdin is not a TTY.
    const result = runSetup(root, [], '');
    expect(result.status, result.stderr).toBe(0);
    // LLM_API_KEY remains at whatever the example default set it to (empty).
    expect(parse(readFileSync(resolve(root, 'agent/.env'), 'utf8')).LLM_API_KEY ?? '').toBe('');
  });

  it('writes piped values for required fields when stdin is provided', () => {
    const root = fixture();
    const stdin = [
      'user-llm-key',         // LLM_API_KEY
      '',                     // LLM_BASE_URL (accept default)
      '',                     // LLM_DEFAULT_MODEL (accept default)
      '',                     // LLM_DISPLAY_NAME (accept default)
      '',                     // LLM_MODELS (accept default)
      '',                     // TELEGRAM_BOT_TOKEN (skip)
      '',                     // RESEND_API_KEY (skip)
      '',                     // RESEND_FROM_EMAIL (accept default)
      '',                     // AGENT_SERVICE_TOKEN (skip)
    ].join('\n') + '\n';
    const result = runSetup(root, [], stdin);
    expect(result.status, result.stderr).toBe(0);
    const values = parse(readFileSync(resolve(root, 'agent/.env'), 'utf8'));
    expect(values.LLM_API_KEY).toBe('user-llm-key');
    expect(values.LLM_BASE_URL).toBe('https://llm.rafiqspace.ai/v1');
    expect(values.LLM_DEFAULT_MODEL).toBe('qwen3.6-35b-a3b-fast');
    expect(values.LLM_DISPLAY_NAME).toBe('Rafiqspace LLM');
    expect(values.LLM_MODELS).toBe('qwen3.6-35b-a3b-fast,qwen3.6-35b-a3b');
    expect(values.RESEND_FROM_EMAIL).toBe('Chekku <onboarding@resend.dev>');
    // Skipped optionals remain at their previous value (empty string from example).
    expect(values.TELEGRAM_BOT_TOKEN ?? '').toBe('');
    expect(values.RESEND_API_KEY ?? '').toBe('');
    expect(values.AGENT_SERVICE_TOKEN ?? '').toBe('');
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "interactive prompts"
```

Expected: FAIL.

- [ ] **Step 3: Append prompt block to `scripts/setup-env.sh`**

Insert immediately after `render_agent_dev_env` and before the future summary block:

```bash
prompt_for_env() {
  local source_env="$1"
  local name="$2"
  local default="$3"
  local mode="$4"   # "required", "default", or "optional"
  local current
  current="$(node - "$source_env" "$name" <<'NODE'
const { readFileSync } = require('node:fs');
const { parse } = require('dotenv');
const [, sourcePath, varName] = process.argv;
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

  local value
  if [[ "$name" == "LLM_API_KEY" || "$name" == "TELEGRAM_BOT_TOKEN" || "$name" == "RESEND_API_KEY" || "$name" == "AGENT_SERVICE_TOKEN" ]]; then
    read -r -s -p "$prompt_text" value </dev/tty || value=""
    echo "" >/dev/tty
  else
    read -r -p "$prompt_text" value </dev/tty || value=""
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

write_env_value() {
  local source_env="$1"
  local name="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp "${source_env}.tmp.XXXXXX")"
  chmod 600 "$tmp"
  node - "$source_env" "$name" "$value" "$tmp" <<'NODE'
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
  mv -f "$tmp" "$source_env"
  chmod 600 "$source_env"
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "interactive prompts"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-env.sh scripts/dev.test.ts
git commit -m "feat(setup-env): interactive prompts with safe hidden input"
```

---

### Task 9: Summary output

**Files:**
- Modify: `scripts/setup-env.sh`
- Modify: `scripts/dev.test.ts`

**Interfaces:**
- Produces: a human-readable summary printed to stdout. Never includes secret values.

- [ ] **Step 1: Write failing tests**

Append to `describe('setup-env.sh', ...)`:

```typescript
describe('summary output', () => {
  it('prints a setup summary without leaking secrets', () => {
    const root = fixture();
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
    for (const value of Object.values({ ...storageValues, ...searxngValues })) {
      expect(result.stdout).not.toContain(value);
      expect(result.stderr).not.toContain(value);
    }
    expect(result.stdout).not.toContain('user-llm-key');
  });

  it('lists optional integrations and any still-missing required values', () => {
    const root = fixture();
    const result = runSetup(root, [], '');  // empty stdin, no LLM_API_KEY provided
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('LLM_API_KEY');
    expect(result.stdout).toContain('TELEGRAM_BOT_TOKEN');
    expect(result.stdout).toContain('RESEND_API_KEY');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "summary output"
```

Expected: FAIL.

- [ ] **Step 3: Append summary block to `scripts/setup-env.sh`**

```bash
print_summary() {
  local agent_values
  agent_values="$(node - "$AGENT_ENV_FILE" <<'NODE'
const { readFileSync } = require('node:fs');
const { parse } = require('dotenv');
const values = parse(readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify({
  LLM_API_KEY: values.LLM_API_KEY ?? '',
  LLM_BASE_URL: values.LLM_BASE_URL ?? '',
  LLM_DEFAULT_MODEL: values.LLM_DEFAULT_MODEL ?? '',
  TELEGRAM_BOT_TOKEN: values.TELEGRAM_BOT_TOKEN ?? '',
  RESEND_API_KEY: values.RESEND_API_KEY ?? '',
}));
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

  local missing_required=()
  node - "$agent_values" <<'NODE'
const payload = JSON.parse(process.argv[2]);
const required = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_DEFAULT_MODEL'];
const missing = required.filter((name) => !payload[name]);
if (missing.length > 0) {
  process.stdout.write(`REQUIRED_MISSING:${missing.join(',')}`);
} else {
  process.stdout.write('REQUIRED_MISSING:');
}
NODE
  local required_marker
  required_marker="$(node - "$agent_values" <<'NODE'
const payload = JSON.parse(process.argv[2]);
const required = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_DEFAULT_MODEL'];
process.stdout.write(required.filter((name) => !payload[name]).join(','));
NODE
)"
  if [[ -n "$required_marker" ]]; then
    echo "Required values you still need to fill (edit agent/.env):"
    for name in ${required_marker//,/ }; do
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "summary output"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-env.sh scripts/dev.test.ts
git commit -m "feat(setup-env): print safe setup summary"
```

---

### Task 10: Modify `dev.sh` — source generated files, hash-based config detection

**Files:**
- Modify: `scripts/dev.sh:7-12` (replace missing-env abort message), `scripts/dev.sh:26-39` (replace `source` calls), `scripts/dev.sh:175-181` (replace `GARAGE_CONFIG_CHANGED` derivation), `scripts/dev.sh` (write `.applied-hash` after healthy).
- Modify: `scripts/dev.test.ts` (add coverage for new abort paths and hash detection).

**Interfaces:**
- Consumes: `storage/.env.local`, `searxng/.env.local`, `storage/.garage/garage.toml`, `storage/.garage/.applied-hash` (may be absent).
- Produces: `storage/.garage/.applied-hash` written when garage becomes healthy.

- [ ] **Step 1: Write failing tests**

Append to `describe('committed local runtime', ...)` (the block that already runs `dev.sh` against a fixture):

```typescript
describe('dev.sh integration with setup-env.sh', () => {
  it('aborts with an actionable message when storage/.env.local is missing', () => {
    const root = fixture();
    // Run setup-env.sh partially: copy agent/.env but skip storage generation.
    writeFileSync(resolve(root, 'agent/.env'), validAgentEnv);
    rmSync(resolve(root, 'storage/.env.local'));
    const result = runDev(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Run scripts/setup-env.sh first');
  });

  it('sets GARAGE_CONFIG_CHANGED=1 on first run (no applied hash)', () => {
    const root = fixture();
    runSetup(root);
    expect(existsSync(resolve(root, 'storage/.garage/.applied-hash'))).toBe(false);
    const result = runDev(root, { CHEKKU_NO_TMUX: '1', GARAGE_RUNNING: '0' });
    expect(result.status, result.stderr).toBe(0);
    // After successful start, the hash file should exist.
    expect(existsSync(resolve(root, 'storage/.garage/.applied-hash'))).toBe(true);
    expect(readFileSync(resolve(root, 'mock-log/start-garage'), 'utf8')).toBeDefined();
  });

  it('does not force-recreate garage when hash matches applied hash', () => {
    const root = fixture();
    runSetup(root);
    // Simulate a previous successful start by writing the current hash.
    const tomlHash = spawnSync(bash, ['-c', `sha256sum "${resolve(root, 'storage/.garage/garage.toml')}" | cut -d' ' -f1`], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(resolve(root, 'storage/.garage/.applied-hash'), tomlHash);
    runDev(root, { CHEKKU_NO_TMUX: '1', GARAGE_RUNNING: '0' });
    const startArgs = readFileSync(resolve(root, 'mock-log/start-garage'), 'utf8');
    expect(startArgs).not.toContain('--force-recreate');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "dev.sh integration with setup-env.sh"
```

Expected: FAIL (old dev.sh still sources deleted-by-now scripts; hash detection not yet implemented).

- [ ] **Step 3: Edit `scripts/dev.sh`**

Replace lines 7-11 (the missing-`.env` abort) — keep it unchanged.

Replace lines 26-34 (the `source storage-env.sh` and `source searxng-env.sh` block plus the compose-config check) with:

```bash
STORAGE_ENV_FILE="$ROOT/storage/.env.local"
SEARXNG_ENV_FILE="$ROOT/searxng/.env.local"
GARAGE_CONFIG_FILE="$ROOT/storage/.garage/garage.toml"
GARAGE_APPLIED_HASH_FILE="$ROOT/storage/.garage/.applied-hash"

for required_file in "$STORAGE_ENV_FILE" "$SEARXNG_ENV_FILE" "$GARAGE_CONFIG_FILE"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Missing $(basename "$required_file"). Run scripts/setup-env.sh first." >&2
    exit 1
  fi
done

set -a
# shellcheck disable=SC1090
source "$STORAGE_ENV_FILE"
# shellcheck disable=SC1090
source "$SEARXNG_ENV_FILE"
set +a

TOML_HASH="$(sha256sum "$GARAGE_CONFIG_FILE" | cut -d' ' -f1)"
APPLIED_HASH=""
if [[ -f "$GARAGE_APPLIED_HASH_FILE" ]]; then
  APPLIED_HASH="$(cat "$GARAGE_APPLIED_HASH_FILE")"
fi
export GARAGE_CONFIG_CHANGED=0
if [[ "$TOML_HASH" != "$APPLIED_HASH" ]]; then
  export GARAGE_CONFIG_CHANGED=1
fi

if ! docker compose --env-file storage/.env.local config --quiet >/dev/null 2>&1; then
  echo "Local services Compose configuration is invalid. Check compose.yaml and generated service configuration." >&2
  exit 1
fi
```

Locate the line `if [[ "$service" == garage && "$GARAGE_CONFIG_CHANGED" == 1 ]]; then` (currently around line 175) and leave it unchanged. Immediately after the `ensure_service_ready garage Garage "${CHEKKU_GARAGE_PORTS:-3900}"` call (currently around line 238), add:

```bash
if [[ "$GARAGE_CONFIG_CHANGED" == 1 ]]; then
  printf '%s' "$TOML_HASH" > "$GARAGE_APPLIED_HASH_FILE"
  chmod 600 "$GARAGE_APPLIED_HASH_FILE"
fi
```

The two `tmux` invocations around lines 259 and 263 currently source `scripts/storage-env.sh` and `scripts/searxng-env.sh`. Replace those source commands with direct loads:

```bash
"set -a && source storage/.env.local && source searxng/.env.local && set +a && $garage_app_cleanup && $searxng_agent_cleanup && exec npm run dev:agent"
```

and

```bash
"set -a && source storage/.env.local && source searxng/.env.local && set +a && $garage_app_cleanup && $searxng_client_cleanup && exec npm run dev:client"
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run scripts/dev.test.ts -t "dev.sh integration with setup-env.sh"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev.sh scripts/dev.test.ts
git commit -m "feat(dev): source generated env files and detect garage config changes via hash"
```

---

### Task 11: Delete old scripts and update docs

**Files:**
- Delete: `scripts/storage-env.sh`
- Delete: `scripts/searxng-env.sh`
- Modify: `scripts/dev.test.ts` (drop the now-defunct `describe('storage environment generation', ...)` and `describe('SearXNG environment generation', ...)` blocks; keep only what is still relevant from the launcher tests).
- Modify: `package.json` (add `setup` script).
- Modify: `README.md` (Quick start section, troubleshooting).
- Modify: `docs/OPERATIONS.md` (script references).
- Modify: `.env.example` (comment update).
- Modify: `agent/.env.example` (comment update).

**Interfaces:**
- Produces: a clean repository where `npm run setup` works end-to-end and no references to deleted scripts remain.

- [ ] **Step 1: Delete the two scripts**

```bash
rm scripts/storage-env.sh scripts/searxng-env.sh
```

- [ ] **Step 2: Remove obsolete describe blocks from `scripts/dev.test.ts`**

Open `scripts/dev.test.ts` and delete the entire `describe('storage environment generation', ...)` and `describe('SearXNG environment generation', ...)` blocks. Their invariants are now covered by the new `describe('storage/.env.local generation', ...)`, `describe('searxng/.env.local generation', ...)`, and `describe('agent/.env.development rendering', ...)` blocks added in earlier tasks.

Also remove `'scripts/storage-env.sh'` and `'scripts/searxng-env.sh'` from the `for (const path of [...])` array in `fixture()` (lines 92-100).

In `describe('committed local runtime', ...)`, update line 1381:

```typescript
const scripts = readFileSync(resolve(sourceRoot, 'scripts/storage-env.sh'), 'utf8');
```

to read from `scripts/setup-env.sh`:

```typescript
const scripts = readFileSync(resolve(sourceRoot, 'scripts/setup-env.sh'), 'utf8');
```

The assertion `expect(scripts).toContain('GARAGE_BUCKET=chekku-objects');` still holds.

- [ ] **Step 3: Add `setup` npm script**

Edit `package.json`:

```json
{
  "scripts": {
    "dev": "concurrently --kill-others-on-fail --names agent,client --prefix-colors cyan,magenta \"npm run dev:agent\" \"npm run dev:client\"",
    "dev:sh": "bash ./scripts/dev.sh",
    "setup": "bash ./scripts/setup-env.sh",
    "dev:agent": "npm run dev --workspace agent",
    "dev:client": "npm run dev --workspace client",
    ...
  }
}
```

- [ ] **Step 4: Update `README.md`**

In the **Quick start** section (lines 133-188), restructure as:

```markdown
## Quick start

### 1. Install dependencies

```bash
npm ci
```

Run `npm ci` from the repository root after the initial clone and after every `git pull`. It replaces stale workspace dependencies with the exact versions in `package-lock.json`. If Mastra exits with an error such as `Invalid Version: ^1.14.0`, rerun `npm ci` before restarting the launcher.

### 2. Configure environment

```bash
npm run setup
```

This copies `.env.example` files into place, auto-generates local Garage and SearXNG secrets, and prompts for required values like `LLM_API_KEY`. Optional integrations (Telegram, Resend, Maestro) can be left empty and edited into `agent/.env` later.

For an existing checkout, rerun `npm run setup` after every `git pull` to pick up new environment variables without losing existing values.

### 3. Start Garage, SearXNG, and both application workspaces

```bash
npm run dev:sh
```
```

In **Troubleshooting → `No model configured`**, add at the end:

```markdown
If `LLM_API_KEY` is missing entirely, rerun `npm run setup` or edit `agent/.env` directly.
```

In the **Commands** table, add:

```markdown
| `npm run setup` | Copy env examples, generate local Garage/SearXNG secrets, prompt for required values. |
```

- [ ] **Step 5: Update `docs/OPERATIONS.md`**

Replace line 36 (`Local \`scripts/searxng-env.sh\` also creates...`) with:

```markdown
The Next.js client process receives zero `SEARXNG_*` values. Only `SEARXNG_BASE_URL` and optional `SEARXNG_API_KEY` are SearXNG application configuration. `scripts/setup-env.sh` (run via `npm run setup`) also creates `searxng/.env.local` with a generated `SEARXNG_SECRET` and configuration hash for Docker Compose. Those values are private local service state: they are not copied to the agent or client application environments and must not be committed, logged, pasted, or configured as application variables.
```

Replace the Local setup snippet at lines 4-10:

```markdown
## Local setup

```bash
npm ci
npm run setup
npm run dev:sh
```

`npm run setup` copies env examples, generates local Garage and SearXNG secrets, and prompts for required values like `LLM_API_KEY`. `npm run dev:sh` starts local services and both workspaces without regenerating files; rerun `npm run setup` whenever environment requirements change.
```

- [ ] **Step 6: Update `.env.example` and `agent/.env.example` comments**

In `.env.example` line 29:

```dotenv
# Server-owned SearXNG search endpoint. Local scripts/setup-env.sh supplies this.
```

In `agent/.env.example` line 34 and line 39:

```dotenv
# Server-owned SearXNG search endpoint. Local scripts/setup-env.sh supplies this.
```

```dotenv
# Garage object storage. scripts/setup-env.sh generates local values.
```

- [ ] **Step 7: Run the full test suite**

Run:
```bash
npm run check
```

Expected: typecheck, lint, and all Vitest tests pass.

If any test fails because it still references `scripts/storage-env.sh` or `scripts/searxng-env.sh`, locate and remove that reference.

- [ ] **Step 8: Run the production build**

Run:
```bash
npm run build
```

Expected: both workspaces build cleanly.

- [ ] **Step 9: Check whitespace**

Run:
```bash
git diff --check
```

Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: fold storage/searxng env scripts into setup-env.sh

Removes scripts/storage-env.sh and scripts/searxng-env.sh in favor of a
single scripts/setup-env.sh that bootstraps, syncs, and prompts. dev.sh
now sources generated files directly and detects Garage config changes
via SHA-256. Updates README, OPERATIONS, and .env.example references."
```

---

### Task 12: Final manual smoke test

**Files:** None modified.

- [ ] **Step 1: From a clean checkout, run setup end-to-end**

In a scratch worktree or after `git stash` of any local env files:

```bash
rm -f agent/.env agent/.env.development client/.env.local
rm -f storage/.env.local searxng/.env.local
rm -rf storage/.garage
npm run setup
```

Expected: prompts for `LLM_API_KEY`, accepts defaults for the LLM fields, leaves optionals empty, prints the summary, and exits 0.

- [ ] **Step 2: Verify all expected files exist with mode 0600**

```bash
ls -l agent/.env agent/.env.development client/.env.local storage/.env.local storage/.garage/garage.toml searxng/.env.local
```

Expected: every file has mode `-rw-------`.

- [ ] **Step 3: Verify idempotency**

```bash
npm run setup
```

Expected: re-run completes without prompting (all values already set), no file content changes, exits 0.

- [ ] **Step 4: Verify dev.sh still starts**

```bash
npm run dev:sh
```

Expected: Garage and SearXNG become healthy; agent and client start. Manually stop with Ctrl-C when satisfied.

- [ ] **Step 5: Verify the sync path**

Add a new variable to `agent/.env.example` (e.g. `CHEKKU_NEW_TEST_VAR=hello`), then run:

```bash
npm run setup
```

Expected: the new variable appears under the `# Added by setup-env.sh (synced from .env.example)` marker in `agent/.env`. Existing values are unchanged. Revert the example file afterward.

- [ ] **Step 6: Final commit if any scratch fixes were made**

```bash
git status
```

Expected: nothing to commit (this task verifies behavior only).

---

## Self-Review Notes

After writing the plan, I reviewed it against the spec:

**Spec coverage:**
- All nine pipeline steps in the spec map to Tasks 2-9.
- dev.sh changes (spec section "dev.sh Changes") map to Task 10.
- Documentation updates map to Task 11.
- Manual smoke test (Task 12) covers the completion checklist's end-to-end criterion.
- Security boundary (service-only secrets never enter app env) is asserted in Tasks 3, 5, 6, and 9.

**Placeholder scan:** No TBD/TODO/placeholder steps. Every code step contains the actual code or command to run.

**Type consistency:** The `runSetup(root, args, stdin, env)` signature is defined in Task 1 and used unchanged in every later task. The `fixture()` helper's path array is updated in Task 1 (adds `setup-env.sh`) and Task 11 (removes the two deleted scripts) — both edits are explicit.

**Known risks carried into execution:**
- The `run()` helper in `dev.test.ts` does not currently accept stdin; Task 1 adds a `runSetup` variant that does. If the variant proves awkward, the implementer may instead refactor `run()` to accept an options object. Either is acceptable as long as stdin support exists.
- The interactive prompt uses `read ... </dev/tty` so that piped-stdin tests can drive prompts via the test runner's `input` option. If Git Bash on Windows does not allow `/dev/tty` redirection, the implementer should fall back to `read ... </dev/stdin` guarded by `[[ -t 0 ]]`. The tests in Task 8 are written to drive prompts via piped stdin regardless of which path is used.
- Task 11 deletes two scripts that other tests reference. The step list explicitly enumerates every reference site that must be updated; if `npm run check` fails after deletion, the cause is almost certainly a missed reference and is easy to locate via grep.
