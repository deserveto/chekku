import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { execSync, spawnSync, type SpawnSyncReturns } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "..");
const bash =
  process.platform === "win32"
    ? "C:\\Program Files\\Git\\bin\\bash.exe"
    : execSync("command -v bash", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
const fixtures: string[] = [];

const AUTH_DATABASE_URL =
  "postgresql://chekku:migrate-password@127.0.0.1:5432/chekku_auth";
const BETTER_AUTH_SECRET = "better-auth-secret-value";

const validClientEnv = [
  `AUTH_DATABASE_URL=${AUTH_DATABASE_URL}`,
  `BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}`,
  "BETTER_AUTH_URL=https://studio.example.test",
  "",
].join("\n");

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
  chmodSync(path, 0o755);
}

function fixture(options: { migrateFails?: boolean } = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), "chekku-db-migrate-"));
  fixtures.push(root);
  for (const directory of ["scripts", "client", "bin"]) {
    mkdirSync(resolve(root, directory));
  }
  writeFileSync(
    resolve(root, "scripts/db-migrate.sh"),
    readFileSync(resolve(sourceRoot, "scripts/db-migrate.sh"), "utf8"),
  );
  writeFileSync(resolve(root, "client/.env.local"), validClientEnv);

  // Records the exact argv the script hands the Better Auth CLI, plus the
  // environment the CLI would resolve its database from.
  executable(
    resolve(root, "bin/npx"),
    `
printf '%s\\n' "$*" >> "$MOCK_LOG/npx"
printf '%s\\n' "\${AUTH_DATABASE_URL:-}" > "$MOCK_LOG/auth-database-url"
printf '%s\\n' "\${NODE_OPTIONS:-}" > "$MOCK_LOG/node-options"
cat > /dev/null
exit ${options.migrateFails ? 1 : 0}
`,
  );

  return root;
}

function runMigrate(
  root: string,
  env: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const log = resolve(root, "mock-log");
  mkdirSync(log, { recursive: true });
  return spawnSync(bash, ["scripts/db-migrate.sh"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      ...env,
      MOCK_LOG: log,
      // db-migrate.sh parses client/.env.local via `node -e ... require('dotenv')`;
      // node resolves from the fixture cwd, which has no node_modules.
      NODE_PATH: resolve(sourceRoot, "node_modules"),
      PATH: `${resolve(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
}

function readLog(root: string, name: string): string {
  const path = resolve(root, "mock-log", name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function configArgument(root: string): string {
  const invocation = readLog(root, "npx").trim();
  const match = /--config\s+(\S+)/.exec(invocation);
  if (!match) {
    throw new Error(`No --config argument in CLI invocation: ${invocation}`);
  }
  return match[1];
}

/**
 * Walks the local import graph of a TypeScript module, following relative and
 * `@/`-aliased specifiers. Bare specifiers (`better-auth`, `pg`, `server-only`)
 * are returned as-is rather than resolved, so a caller can assert on them.
 */
function collectLocalImports(
  entry: string,
  clientRoot: string,
  seen = new Set<string>(),
  bare = new Set<string>(),
): { files: Set<string>; bare: Set<string> } {
  if (seen.has(entry)) return { files: seen, bare };
  seen.add(entry);

  // Comments routinely quote `import 'server-only'` while explaining why a
  // module avoids it; scanning them would report an import that does not exist.
  const source = readFileSync(entry, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"\\])\/\/.*$/gm, "$1");
  const specifiers = [
    ...source.matchAll(/(?:from\s+|import\s+)['"]([^'"]+)['"]/g),
  ].map((match) => match[1]);

  for (const specifier of specifiers) {
    let candidate: string | undefined;
    if (specifier.startsWith(".")) {
      candidate = resolve(dirname(entry), specifier);
    } else if (specifier.startsWith("@/")) {
      candidate = resolve(clientRoot, "src", specifier.slice(2));
    } else {
      bare.add(specifier);
      continue;
    }
    const resolved = [
      candidate,
      `${candidate}.ts`,
      `${candidate}.tsx`,
      resolve(candidate, "index.ts"),
    ].find((path) => existsSync(path) && path.endsWith(".ts"));
    if (resolved) collectLocalImports(resolved, clientRoot, seen, bare);
  }

  return { files: seen, bare };
}

afterEach(() => {
  while (fixtures.length) {
    rmSync(fixtures.pop()!, { recursive: true, force: true });
  }
});

describe("scripts/db-migrate.sh", () => {
  it("points the Better Auth CLI at a config free of the server-only import chain", () => {
    const root = fixture();
    const result = runMigrate(root);
    expect(result.status).toBe(0);

    const clientRoot = resolve(sourceRoot, "client");
    const configPath = resolve(clientRoot, configArgument(root));
    expect(existsSync(configPath)).toBe(true);

    // @better-auth/cli refuses to load any config whose import graph reaches
    // `server-only`: it aborts with "Please remove import 'server-only' from
    // your auth config file". Resolution tricks (NODE_OPTIONS
    // --conditions react-server) do not help, so the config the script points
    // at must not reach that module at all — directly or transitively.
    const { bare } = collectLocalImports(configPath, clientRoot);
    expect([...bare]).not.toContain("server-only");
  });

  it("exports the auth database URL the CLI connects with", () => {
    const root = fixture();
    const result = runMigrate(root);

    expect(result.status).toBe(0);
    expect(readLog(root, "auth-database-url").trim()).toBe(AUTH_DATABASE_URL);
  });

  it("reports a failed migration instead of claiming success", () => {
    const root = fixture({ migrateFails: true });
    const result = runMigrate(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Better Auth migration failed");
  });

  it("keeps the migration log out of the shipped output", () => {
    const root = fixture();
    const result = runMigrate(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Better Auth schema applied");
    expect(result.stdout).not.toContain(BETTER_AUTH_SECRET);
  });
});
