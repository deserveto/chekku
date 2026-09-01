import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
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

const POSTGRES_PASSWORD = "prod-postgres-password";
const GARAGE_ACCESS_KEY_ID = "GKPRODACCESSKEYID123";
const GARAGE_SECRET_ACCESS_KEY = "prod-garage-secret-key";
const LLM_API_KEY = "prod-llm-api-key";

const validAgentEnv = [
  "NODE_ENV=production",
  `LLM_BASE_URL=https://llm.example.test/v1`,
  `LLM_API_KEY=${LLM_API_KEY}`,
  "LLM_DEFAULT_MODEL=prod-model",
  // Values that bash `source` cannot parse (spaces, angle brackets) — prod.sh
  // must parse these via node+dotenv, not `source`. Regression for the
  // "LLM: command not found" failure caused by `LLM_DISPLAY_NAME=Rafiqspace LLM`.
  "LLM_DISPLAY_NAME=Rafiqspace LLM",
  "RESEND_FROM_EMAIL=Chekku <onboarding@resend.dev>",
  "WEB_URL=https://studio.example.test",
  "GARAGE_ENDPOINT=",
  "GARAGE_REGION=",
  "GARAGE_BUCKET=",
  "GARAGE_ACCESS_KEY_ID=",
  "GARAGE_SECRET_ACCESS_KEY=",
  "",
].join("\n");

const validStorageEnv = [
  `GARAGE_ENDPOINT=http://garage:3900`,
  `GARAGE_REGION=garage`,
  `GARAGE_BUCKET=chekku-objects`,
  `GARAGE_ACCESS_KEY_ID=${GARAGE_ACCESS_KEY_ID}`,
  `GARAGE_SECRET_ACCESS_KEY=${GARAGE_SECRET_ACCESS_KEY}`,
  `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
  "GARAGE_RPC_SECRET=service-only-rpc",
  "GARAGE_ADMIN_TOKEN=service-only-admin",
  "GARAGE_METRICS_TOKEN=service-only-metrics",
  "",
].join("\n");

const validSearxngEnv = [
  "SEARXNG_SECRET=service-only-searxng",
  "SEARXNG_CONFIG_HASH=service-only-hash",
  "SEARXNG_BASE_URL=http://searxng:8080",
  "SEARXNG_API_KEY=",
  "",
].join("\n");

const BETTER_AUTH_SECRET = "better-auth-secret-value";

const validClientEnv = [
  "AGENT_URL=http://agent:4111",
  "NEXT_PUBLIC_APP_URL=https://studio.example.test",
  "CHEKKU_LOCAL_USER_ID=local-user",
  `BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}`,
  "BETTER_AUTH_URL=https://studio.example.test",
  "",
].join("\n");

const secretValues = [
  POSTGRES_PASSWORD,
  GARAGE_ACCESS_KEY_ID,
  GARAGE_SECRET_ACCESS_KEY,
  LLM_API_KEY,
  BETTER_AUTH_SECRET,
  "service-only-rpc",
  "service-only-admin",
  "service-only-metrics",
  "service-only-searxng",
  "service-only-hash",
];

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
  chmodSync(path, 0o755);
}

function fixture(
  options: {
    unhealthyService?: string;
    composeAvailable?: boolean;
    configFails?: boolean;
  } = {},
): string {
  const root = mkdtempSync(resolve(tmpdir(), "chekku-prod-"));
  fixtures.push(root);
  for (const directory of [
    "scripts",
    "storage",
    "searxng",
    "agent",
    "client",
    "bin",
  ]) {
    mkdirSync(resolve(root, directory));
  }
  for (const path of [
    "scripts/prod.sh",
    "scripts/setup-env.sh",
    "storage/garage.toml.template",
    "searxng/settings.yml",
    "compose.yaml",
    "compose.prod.yaml",
    ".gitignore",
    "agent/.env.example",
    "client/.env.example",
  ]) {
    copyFileSync(resolve(sourceRoot, path), resolve(root, path));
  }
  writeFileSync(resolve(root, "agent/.env"), validAgentEnv);
  writeFileSync(resolve(root, "client/.env.local"), validClientEnv);
  writeFileSync(resolve(root, "storage/.env.local"), validStorageEnv);
  writeFileSync(resolve(root, "searxng/.env.local"), validSearxngEnv);

  executable(
    resolve(root, "bin/docker"),
    `
echo "$*" >> "$MOCK_LOG/docker"
if [[ "$1" == compose ]]; then
  if [[ "$*" == *" version" ]]; then [[ "\${COMPOSE_AVAILABLE:-1}" == 1 ]]; exit; fi
  if [[ "$*" == *" config --quiet" ]]; then [[ "\${COMPOSE_CONFIG_FAIL:-0}" != 1 ]]; exit; fi
  if [[ "$*" == *" build agent client" ]]; then touch "$MOCK_LOG/build"; exit 0; fi
  if [[ "$*" == *" up -d --build" ]]; then touch "$MOCK_LOG/up"; exit 0; fi
  if [[ "$*" == *" down" ]]; then touch "$MOCK_LOG/down"; exit 0; fi
  if [[ "$*" == *" ps -q garage" ]]; then printf 'garage-id\\n'; exit 0; fi
  if [[ "$*" == *" ps -q searxng" ]]; then printf 'searxng-id\\n'; exit 0; fi
  if [[ "$*" == *" ps -q reader" ]]; then printf 'reader-id\\n'; exit 0; fi
  if [[ "$*" == *" ps -q postgres" ]]; then printf 'postgres-id\\n'; exit 0; fi
  if [[ "$*" == *" ps -q agent" ]]; then printf 'agent-id\\n'; exit 0; fi
  if [[ "$*" == *" ps -q client" ]]; then printf 'client-id\\n'; exit 0; fi
  if [[ "$*" == *" ps -q qdrant" ]]; then printf 'qdrant-id\\n'; exit 0; fi
  exit 0
fi
if [[ "$1" == inspect ]]; then
  case "\${*: -1}" in
    garage-id|searxng-id|reader-id|postgres-id|agent-id|client-id|qdrant-id) service="\${*: -1}"; service="\${service%-id}" ;;
    *) service=unknown ;;
  esac
  if [[ "$service" == "\${UNHEALTHY_SERVICE:-}" ]]; then printf 'starting\\n'; exit 0; fi
  printf 'healthy\\n'
fi
`,
  );

  return root;
}

function run(
  root: string,
  args: string[],
  env: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const log = resolve(root, "mock-log");
  mkdirSync(log, { recursive: true });
  const childEnv: Record<string, string> = {
    ...process.env,
    ...env,
    MOCK_LOG: log,
    // prod.sh parses dotenv files via `node -e ... require('dotenv')`; node
    // resolves from the fixture cwd, which has no node_modules, so point it
    // at the real repo node_modules (same pattern as scripts/dev.test.ts).
    NODE_PATH: resolve(sourceRoot, "node_modules"),
    PATH: `${resolve(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
  };
  // vitest.setup.js pins inert LLM_* defaults for the agent composition root;
  // strip them here so the fixture's own dotenv files (and their deliberately
  // empty secrets) are what prod.sh validates — not values inherited from the
  // test runner process.
  for (const key of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_DEFAULT_MODEL"])
    delete childEnv[key];
  return spawnSync(bash, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: childEnv,
  });
}

function runProd(
  root: string,
  args: string[] = [],
  env: Record<string, string> = {},
): SpawnSyncReturns<string> {
  return run(root, ["scripts/prod.sh", ...args], {
    CHEKKU_READY_TIMEOUT_SECONDS: "2",
    ...env,
  });
}

afterEach(() => {
  for (const root of fixtures.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("production launcher prerequisites", () => {
  it("aborts when Docker Compose is unavailable", () => {
    const root = fixture();
    const result = runProd(root, [], { COMPOSE_AVAILABLE: "0" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Docker Compose is required");
  });

  it("aborts when a required env file is missing", () => {
    const root = fixture();
    rmSync(resolve(root, "storage/.env.local"), { force: true });
    const result = runProd(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Run scripts/setup-env.sh first");
  });

  it("aborts when a required application value is empty", () => {
    const root = fixture();
    writeFileSync(
      resolve(root, "agent/.env"),
      validAgentEnv.replace(`LLM_API_KEY=${LLM_API_KEY}`, "LLM_API_KEY="),
    );
    const result = runProd(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LLM_API_KEY is empty");
  });

  it("aborts when a required Better Auth value is empty", () => {
    const root = fixture();
    writeFileSync(
      resolve(root, "client/.env.local"),
      validClientEnv.replace(
        `BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}`,
        "BETTER_AUTH_SECRET=",
      ),
    );
    const result = runProd(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("BETTER_AUTH_SECRET is empty");
  });

  it("rejects an unknown action", () => {
    const root = fixture();
    const result = runProd(root, ["nope"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage:");
  });
});

describe("production launcher flow", () => {
  it("validates compose config before any build or up", () => {
    const root = fixture();
    const result = runProd(root, [], { COMPOSE_CONFIG_FAIL: "1" });
    const dockerLog = readFileSync(resolve(root, "mock-log/docker"), "utf8");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Production Compose configuration is invalid",
    );
    expect(existsSync(resolve(root, "mock-log/build"))).toBe(false);
    expect(existsSync(resolve(root, "mock-log/up"))).toBe(false);
    // config is the first compose subcommand after the availability check
    expect(dockerLog).toContain("config --quiet");
  });

  it("always merges the prod overlay and the storage env-file", () => {
    const root = fixture();
    const result = runProd(root);
    const dockerLog = readFileSync(resolve(root, "mock-log/docker"), "utf8");

    expect(result.status, result.stderr).toBe(0);
    // Every compose invocation except the bare availability check carries the
    // env-file and both -f files, and nothing activates a profile anymore.
    for (const line of dockerLog
      .split("\n")
      .filter(
        (entry) => entry.includes("compose") && !entry.includes(" version"),
      )) {
      expect(line).toContain("--env-file storage/.env.local");
      expect(line).toContain("-f compose.yaml");
      expect(line).toContain("-f compose.prod.yaml");
      expect(line).not.toContain("--profile");
    }
  });

  it("runs up with --build and waits for every service to be healthy", () => {
    const root = fixture();
    const result = runProd(root);
    const dockerLog = readFileSync(resolve(root, "mock-log/docker"), "utf8");

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(resolve(root, "mock-log/up"))).toBe(true);
    expect(dockerLog).toContain("up -d --build");
    expect(result.stdout).toContain("Garage ready");
    expect(result.stdout).toContain("SearXNG ready");
    expect(result.stdout).toContain("Postgres ready");
    expect(result.stdout).toContain("Agent ready");
    expect(result.stdout).toContain("Client ready");
    expect(result.stdout).toContain("Production stack is running");
  });

  it("orders readiness as garage, searxng, reader, qdrant, postgres, agent, client", () => {
    const root = fixture();
    const result = runProd(root);
    const readyOrder = [
      result.stdout.indexOf("Garage ready"),
      result.stdout.indexOf("SearXNG ready"),
      result.stdout.indexOf("Reader ready"),
      result.stdout.indexOf("Qdrant ready"),
      result.stdout.indexOf("Postgres ready"),
      result.stdout.indexOf("Agent ready"),
      result.stdout.indexOf("Client ready"),
    ];
    expect(result.status, result.stderr).toBe(0);
    for (let i = 1; i < readyOrder.length; i += 1) {
      expect(readyOrder[i]).toBeGreaterThan(readyOrder[i - 1]);
    }
    expect(result.stdout).toContain("Qdrant ready");
  });

  it("aborts with a bounded message when a service never becomes healthy", () => {
    const root = fixture();
    const result = runProd(root, [], { UNHEALTHY_SERVICE: "agent" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Agent did not become healthy within 2 seconds",
    );
    // Client must never be reported ready when agent is unhealthy.
    expect(result.stdout).not.toContain("Client ready");
  });
});

describe("production launcher subcommands", () => {
  it("build action only builds the agent and client images", () => {
    const root = fixture();
    const result = runProd(root, ["build"]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(resolve(root, "mock-log/build"))).toBe(true);
    expect(result.stdout).toContain("Images built");
    expect(existsSync(resolve(root, "mock-log/up"))).toBe(false);
  });

  it("down action stops the stack without building", () => {
    const root = fixture();
    const result = runProd(root, ["down"]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(resolve(root, "mock-log/down"))).toBe(true);
    expect(existsSync(resolve(root, "mock-log/build"))).toBe(false);
    expect(result.stdout).toContain("Production stack stopped");
  });
});

describe("production launcher secret-validation scoping", () => {
  // Regression for the issue where unconditional `require_env` at the top of
  // prod.sh blocked `down`/`build` when an LLM_* value was empty. Runtime
  // secrets are only required to START containers, so teardown and image
  // build must succeed with an incomplete agent env.
  function fixtureWithEmptyLlmKey(): string {
    const root = fixture();
    writeFileSync(
      resolve(root, "agent/.env"),
      validAgentEnv.replace(`LLM_API_KEY=${LLM_API_KEY}`, "LLM_API_KEY="),
    );
    return root;
  }

  it("build does not require LLM_* runtime secrets", () => {
    const root = fixtureWithEmptyLlmKey();
    const result = runProd(root, ["build"]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(resolve(root, "mock-log/build"))).toBe(true);
  });

  it("down does not require LLM_* runtime secrets (can tear down a partial stack)", () => {
    const root = fixtureWithEmptyLlmKey();
    const result = runProd(root, ["down"]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(resolve(root, "mock-log/down"))).toBe(true);
  });

  it("up still fails closed on an empty required runtime secret", () => {
    const root = fixtureWithEmptyLlmKey();
    const result = runProd(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LLM_API_KEY is empty");
    // up must not have started.
    expect(existsSync(resolve(root, "mock-log/up"))).toBe(false);
  });
});

describe("production launcher secret hygiene", () => {
  it("never prints service-only or application secrets to stdout or stderr", () => {
    const root = fixture();
    const result = runProd(root);
    expect(result.status, result.stderr).toBe(0);
    for (const secret of secretValues) {
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
  });

  it("parses dotenv values with spaces and special characters without bash errors", () => {
    const root = fixture();
    // validAgentEnv includes `LLM_DISPLAY_NAME=Rafiqspace LLM` and
    // `RESEND_FROM_EMAIL=Chekku <onboarding@resend.dev>`. A naive `source`
    // treats `LLM` as a command and `<...>` as input redirection.
    const result = runProd(root, ["build"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("command not found");
    expect(result.stderr).not.toContain("No such file or directory");
  });
});

describe("committed production runtime", () => {
  it("prod overlay publishes only the client and postgres loopback ports", () => {
    const prod = readFileSync(resolve(sourceRoot, "compose.prod.yaml"), "utf8");
    expect(prod).toContain('"127.0.0.1:${CHEKKU_CLIENT_HOST_PORT:-3000}:3000"');
    expect(prod).toContain('"127.0.0.1:${CHEKKU_POSTGRES_HOST_PORT:-5432}:5432"');
    expect(prod).toMatch(/^[ \t]+ports:/m);
    expect(prod).not.toContain("profiles:");
    const published = prod.match(/- "127\.0\.0\.1:[^"]+"/g) ?? [];
    expect(published).toHaveLength(2);
    for (const internal of [":3900:", ":8888:", ":8081:", ":6333:"]) {
      expect(prod).not.toContain(internal);
    }
    for (const leaked of [3901, 3902, 3903]) {
      expect(prod).not.toMatch(new RegExp(`^[^#]*${leaked}:${leaked}`, "m"));
    }
  });
});
