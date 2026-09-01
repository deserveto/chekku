import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// The agent workspace build script runs repository-level helpers by relative
// path (`mastra build && node ../scripts/fix-mastra-specifiers.mjs`). Those
// helpers live outside `agent/`, so the containerized build only works if
// `agent/Dockerfile` copies them into the builder stage as well.
//
// Regression for #50: that commit added the specifier-fixing helper and wired
// it into the build script but left `agent/Dockerfile` copying only `agent/`
// and `storage/`. The image build then failed inside the builder with
// `MODULE_NOT_FOUND` and an empty `requireStack` — node could not load the
// entry point because `/app/scripts/fix-mastra-specifiers.mjs` did not exist.
// Host builds kept working, so nothing caught it until the next prod build.
const sourceRoot = resolve(import.meta.dirname, "..");
const dockerfile = readFileSync(resolve(sourceRoot, "agent/Dockerfile"), "utf8");
const agentBuildScript: string = JSON.parse(
  readFileSync(resolve(sourceRoot, "agent/package.json"), "utf8"),
).scripts.build;

/** Paths under `scripts/` that the agent build script executes, repo-relative. */
const referencedScripts = [
  ...agentBuildScript.matchAll(/\.\.\/(scripts\/[\w.-]+)/g),
].map((match) => match[1]);

/**
 * The builder stage only — `COPY --from=builder` lines in the runtime stage
 * copy build output, not build context, and must not satisfy these assertions.
 */
const builderStage = (() => {
  const start = dockerfile.search(/^FROM .+ AS builder$/m);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = dockerfile.slice(start + 1);
  const end = rest.search(/^FROM /m);
  return end === -1 ? rest : rest.slice(0, end);
})();

/** Build-context sources of every `COPY` in the builder stage, with their offsets. */
const contextCopies = [...builderStage.matchAll(/^COPY (?!--from)(.+)$/gm)]
  .flatMap((match) => {
    const parts = match[1].trim().split(/\s+/);
    // The final token is the destination; everything before it is a source.
    return parts.slice(0, -1).map((source) => ({
      source,
      index: match.index,
    }));
  })
  .filter(({ source }) => !source.startsWith("--"));

const buildStepIndex = builderStage.search(
  /^RUN npm run build --workspace agent$/m,
);

/** True when `copySource` brings `path` into the image, directly or via its directory. */
const covers = (copySource: string, path: string) => {
  const normalized = copySource.replace(/\/$/, "");
  return normalized === path || path.startsWith(`${normalized}/`);
};

describe("agent/Dockerfile builder stage", () => {
  it("runs the agent workspace build", () => {
    expect(buildStepIndex).toBeGreaterThanOrEqual(0);
  });

  it("matches the helpers the agent build script actually invokes", () => {
    // Guards the test itself: if the build script stops calling repo scripts,
    // this fails loudly rather than silently asserting nothing.
    expect(referencedScripts).toEqual(["scripts/fix-mastra-specifiers.mjs"]);
  });

  it.each(referencedScripts)("copies %s into the build context", (path) => {
    const copy = contextCopies.find(({ source }) => covers(source, path));
    expect(
      copy,
      `agent/Dockerfile builder stage never copies ${path}, which agent's build script runs`,
    ).toBeDefined();
    // Copying it after the build step would be useless.
    expect(copy!.index).toBeLessThan(buildStepIndex);
  });
});
