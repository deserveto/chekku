#!/usr/bin/env python3
from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path

EXPECTED_HEAD = "8a1321d124ef9f1c4b60052c723fa77a6bd8bcee"
EXPECTED_MAIN = "97b1556d1eaca7257b9285b99c961ff9ede732d9"
EXPECTED_CONFLICTS = {
    "agent/src/agents/main-agent.ts",
    "agent/src/mastra/runs/execute.test.ts",
}


def run(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        list(args), cwd=repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
    )
    print(f"$ {' '.join(args)}")
    if proc.stdout:
        print(proc.stdout, end="" if proc.stdout.endswith("\n") else "\n")
    if check and proc.returncode != 0:
        raise SystemExit(proc.returncode)
    return proc


def read(repo: Path, rel: str) -> str:
    return (repo / rel).read_text(encoding="utf-8")


def write(repo: Path, rel: str, text: str) -> None:
    (repo / rel).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def integrate(repo: Path) -> None:
    actual_head = run(repo, "git", "rev-parse", "HEAD").stdout.strip()
    if actual_head != EXPECTED_HEAD:
        raise RuntimeError(f"unexpected PR head: {actual_head}")

    run(repo, "git", "fetch", "origin", "main")
    actual_main = run(repo, "git", "rev-parse", "origin/main").stdout.strip()
    if actual_main != EXPECTED_MAIN:
        raise RuntimeError(
            f"main moved during verification: expected {EXPECTED_MAIN}, got {actual_main}; rerun investigation"
        )

    merge = run(repo, "git", "merge", "--no-commit", "--no-ff", "origin/main", check=False)
    if merge.returncode == 0:
        raise RuntimeError(
            "expected the two reviewed conflicts, but merge completed cleanly; integration assumptions changed"
        )

    unresolved = {
        line.strip()
        for line in run(repo, "git", "diff", "--name-only", "--diff-filter=U").stdout.splitlines()
        if line.strip()
    }
    if unresolved != EXPECTED_CONFLICTS:
        raise RuntimeError(f"unexpected conflict set: {sorted(unresolved)}")

    main_agent = "agent/src/agents/main-agent.ts"
    run(repo, "git", "checkout", "--theirs", "--", main_agent)
    text = read(repo, main_agent)
    text = replace_once(
        text,
        "import { createAgentContextLimiter, createAgentMemory, createCharBudgetGuard } from '../mastra/processors/context-limit.js';",
        "import {\n  createAgentContextLimiter,\n  createAgentMemory,\n  createCharBudgetGuard,\n  TITLE_GENERATION_INSTRUCTIONS,\n} from '../mastra/processors/context-limit.js';",
        "main-agent context-limit import",
    )
    text = replace_once(
        text,
        "memory: createAgentMemory({ generateTitle: true }),",
        "memory: createAgentMemory({ generateTitle: { instructions: TITLE_GENERATION_INSTRUCTIONS } }),",
        "main-agent title configuration",
    )
    if "createDescriptionForwardingDurableAgent" not in text:
        raise RuntimeError("main-agent lost main's description-forwarding durable wrapper")
    write(repo, main_agent, text)

    execute_test = "agent/src/mastra/runs/execute.test.ts"
    run(repo, "git", "checkout", "--ours", "--", execute_test)
    ours = read(repo, execute_test).rstrip() + "\n"
    main_version = run(repo, "git", "show", f"origin/main:{execute_test}").stdout
    marker = "describe('runExecution token usage recording'"
    marker_index = main_version.find(marker)
    if marker_index < 0:
        raise RuntimeError("main quota regression block not found")
    block_start = main_version.rfind("\n", 0, marker_index)
    quota_block = main_version[block_start + 1 :].strip() + "\n"
    if marker in ours:
        raise RuntimeError("quota block unexpectedly already present in PR-side execute.test")
    write(repo, execute_test, ours + "\n" + quota_block)

    run(repo, "git", "add", main_agent, execute_test)
    still_unresolved = run(repo, "git", "diff", "--name-only", "--diff-filter=U").stdout.strip()
    if still_unresolved:
        raise RuntimeError(f"unresolved merge files remain: {still_unresolved}")

    run(repo, "git", "config", "user.name", "ChatGPT PR58 Verifier")
    run(
        repo,
        "git",
        "config",
        "user.email",
        "41898282+github-actions[bot]@users.noreply.github.com",
    )
    run(repo, "git", "commit", "-m", "Merge main into fix/studio-stability-knowledge-titles-pdf")


def add_tests(repo: Path) -> None:
    path = "client/src/components/chat/chat-studio.runs.test.tsx"
    text = read(repo, path)
    text = replace_once(
        text,
        "import { act, type ReactNode } from 'react';",
        "import { StrictMode, act, type ReactNode } from 'react';",
        "ChatStudio StrictMode import",
    )
    marker = "  it('retries the delayed refresh on a bounded backoff while the thread stays untitled', async () => {"
    strict_test = r'''  it('keeps delayed title refresh alive under StrictMode', async () => {
    // Regression: StrictMode runs setup → cleanup → setup in development.
    // mountedRef must be restored to true by the live setup or the
    // post-terminal continuation returns before scheduling the title refresh.
    act(() => root?.unmount());
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    listAgentThreads.mockResolvedValue(untitledThreads);

    let resolveObservation: (() => void) | undefined;
    observeRunEvents.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveObservation = resolve;
        }),
    );
    act(() => {
      root!.render(
        <StrictMode>
          <ChatStudio
            resourceId="local-user"
            initialAgentId="main-agent"
            initialThreadId={activeThreadId}
          />
        </StrictMode>,
      );
    });
    await flushEffects();
    await enterComposerText('strict title refresh');
    await submitComposer();

    vi.useFakeTimers();
    let callsAfterCompletion = 0;
    await act(async () => {
      resolveObservation?.();
      await vi.advanceTimersByTimeAsync(0);
      callsAfterCompletion = listAgentThreads.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(listAgentThreads.mock.calls.length).toBe(callsAfterCompletion + 1);
  });

'''
    text = replace_once(text, marker, strict_test + marker, "ChatStudio StrictMode test insertion")
    write(repo, path, text)

    path = "client/src/app/(studio)/knowledge/knowledge-document-list.test.tsx"
    text = read(repo, path)
    marker = "  it('retries failed documents through the retry endpoint', async () => {"
    deletion_test = r'''  it('hides retry while deletion is in flight', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);
    const container = render(
      <KnowledgeDocumentList
        initialDocuments={[doc({ status: 'failed', error: 'boom' })]}
      />,
    );
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Retry indexing',
      ),
    ).toBe(true);

    const deleteButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Delete',
    ) as HTMLButtonElement;
    await act(async () => { deleteButton.click(); });
    const dialog = container.querySelector('dialog');
    const confirmButton = [...dialog!.querySelectorAll('button')].find(
      (button) => button.textContent === 'Delete',
    ) as HTMLButtonElement;
    await act(async () => { confirmButton.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('[data-knowledge-status="deleting"]')).toBeTruthy();
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Retry indexing',
      ),
    ).toBe(false);
  });

'''
    text = replace_once(text, marker, deletion_test + marker, "delete/retry regression insertion")
    write(repo, path, text)

    path = "agent/src/knowledge/qdrant-index.test.ts"
    text = read(repo, path)
    anchor = "    expect(opLogs).toContain('[knowledge] qdrant search failed:');\n"
    text = replace_once(
        text,
        anchor,
        anchor + "    expect(errorSpy).toHaveBeenCalledTimes(3);\n",
        "Qdrant single-log assertion",
    )
    write(repo, path, text)

    path = "client/src/lib/ui-structure.test.ts"
    text = read(repo, path)
    marker = "  it('lets each sidebar place its collapse control in the brand row', () => {"
    css_test = r'''  it('keeps the failed Knowledge chip on the danger color without a stale override', () => {
    const failedRules = [...css.matchAll(
      /\.chat-knowledge-status\[data-knowledge-state='failed'\]\s*\{([^}]*)\}/g,
    )].map((match) => match[1]);
    expect(failedRules).toHaveLength(1);
    expect(failedRules[0]).toContain('color: var(--studio-danger)');
    expect(failedRules[0]).not.toContain('var(--studio-warning)');
  });

'''
    text = replace_once(text, marker, css_test + marker, "failed-chip CSS regression insertion")
    write(repo, path, text)

    run(
        repo,
        "git",
        "add",
        "client/src/components/chat/chat-studio.runs.test.tsx",
        "client/src/app/(studio)/knowledge/knowledge-document-list.test.tsx",
        "agent/src/knowledge/qdrant-index.test.ts",
        "client/src/lib/ui-structure.test.ts",
    )


def apply_fixes(repo: Path) -> None:
    path = "client/src/app/(studio)/knowledge/knowledge-document-list.tsx"
    text = read(repo, path)
    text = replace_once(
        text,
        "                {retryable ? (\n",
        "                {retryable && !deleting ? (\n",
        "suppress retry during deletion",
    )
    write(repo, path, text)

    path = "agent/src/knowledge/qdrant-index.ts"
    text = read(repo, path)
    old = """function mapIndexError(error: unknown): KnowledgeIndexError {\n  if (error instanceof KnowledgeIndexError) return error;\n  // Fixed-code logging: raw provider errors can embed URLs and bodies, so\n  // only the error name reaches the log line.\n  console.error('[knowledge] qdrant request failed:', error instanceof Error ? error.name : 'unknown');\n  return new KnowledgeIndexError('unavailable', 'The knowledge index is currently unavailable.');\n}\n"""
    new = """function mapIndexError(error: unknown): KnowledgeIndexError {\n  if (error instanceof KnowledgeIndexError) return error;\n  return new KnowledgeIndexError('unavailable', 'The knowledge index is currently unavailable.');\n}\n"""
    text = replace_once(text, old, new, "remove duplicate Qdrant logging")
    write(repo, path, text)

    path = "client/src/app/studio.css"
    text = read(repo, path)
    stale = """.chat-knowledge-status[data-knowledge-state='failed'] {\n  color: var(--studio-warning);\n  border-style: solid;\n}\n\n"""
    text = replace_once(text, stale, "", "remove stale failed-chip warning override")
    write(repo, path, text)

    path = "AGENTS.md"
    text = read(repo, path)
    old_title = "createAgentMemory({ generateTitle: true })"
    title_count = text.count(old_title)
    if title_count != 4:
        raise RuntimeError(f"AGENTS title contract: expected 4 stale occurrences, found {title_count}")
    text = text.replace(
        old_title,
        "createAgentMemory({ generateTitle: { instructions: TITLE_GENERATION_INSTRUCTIONS } })",
    )
    old_knowledge = (
        "`search_knowledge_base` is bound to `main-agent` only, derives the tenant from "
        "`context.agent.resourceId` (input schema has no tenant field), and must never enter any MCP or stored-agent registry."
    )
    new_knowledge = (
        "`search_knowledge_base` is bound to `main-agent` only and derives the tenant from the server-owned "
        "`MASTRA_RESOURCE_ID_KEY` requestContext value, with `context.agent.resourceId` only as a defense-in-depth fallback "
        "(input schema has no tenant field); it must never enter any MCP or stored-agent registry."
    )
    text = replace_once(text, old_knowledge, new_knowledge, "AGENTS knowledge identity contract")
    old_pdf = (
        "Restored messages have no `documentId` linkage: `attachmentsFromContent` groups consecutive complete "
        "`\"{name} (page i of n)\"` page-image runs into one pdf attachment (a group counts as ONE attachment toward the 24 cap; "
        "oversized groups are skipped whole; broken runs degrade to individual images, never dropping data), and the viewer falls back to the grouped page images."
    )
    new_pdf = (
        "Restored messages have no `documentId` linkage: Mastra persistence strips file-part `filename`s, so "
        "`attachmentsFromContent` aligns persisted image parts with the surviving sentinel manifest labels "
        "(`[Attached image N of M: <name> — page i of n]`) and groups only complete sequential page runs into one PDF attachment "
        "(a group counts as ONE attachment toward the 24 cap; oversized groups are skipped whole; broken or misaligned runs degrade to individual images, never dropping data); "
        "the viewer falls back to those grouped page images."
    )
    text = replace_once(text, old_pdf, new_pdf, "AGENTS PDF restore contract")
    write(repo, path, text)

    run(
        repo,
        "git",
        "add",
        "client/src/app/(studio)/knowledge/knowledge-document-list.tsx",
        "agent/src/knowledge/qdrant-index.ts",
        "client/src/app/studio.css",
        "AGENTS.md",
    )


def verify_static(repo: Path) -> None:
    if run(repo, "git", "diff", "--name-only", "--diff-filter=U").stdout.strip():
        raise RuntimeError("unresolved merge conflicts remain")
    run(repo, "git", "diff", "--check")

    main_agent = read(repo, "agent/src/agents/main-agent.ts")
    for needle in [
        "createDescriptionForwardingDurableAgent",
        "TITLE_GENERATION_INSTRUCTIONS",
        "generateTitle: { instructions: TITLE_GENERATION_INSTRUCTIONS }",
    ]:
        if needle not in main_agent:
            raise RuntimeError(f"main-agent integration invariant missing: {needle}")
    if "createDurableAgent" in main_agent:
        raise RuntimeError("main-agent regressed to stock durable wrapper")

    execute_test = read(repo, "agent/src/mastra/runs/execute.test.ts")
    for needle in ["describe('sanitizeThreadTitle'", "describe('runExecution token usage recording'"]:
        if needle not in execute_test:
            raise RuntimeError(f"execute.test integration invariant missing: {needle}")

    agents = read(repo, "AGENTS.md")
    if "createAgentMemory({ generateTitle: true })" in agents:
        raise RuntimeError("AGENTS still contains stale boolean title-generation contract")
    if "derives the tenant from `context.agent.resourceId`" in agents:
        raise RuntimeError("AGENTS still contains stale Knowledge tenant identity contract")
    if "surviving sentinel manifest labels" not in agents:
        raise RuntimeError("AGENTS PDF restore contract was not corrected")

    css = read(repo, "client/src/app/studio.css")
    failed_selector = ".chat-knowledge-status[data-knowledge-state='failed']"
    if css.count(failed_selector + " {") != 1:
        raise RuntimeError("failed Knowledge chip must have exactly one direct state rule")
    if "color: var(--studio-warning);\n  border-style: solid;" in css:
        raise RuntimeError("stale amber failed-chip override remains")

    qdrant = read(repo, "agent/src/knowledge/qdrant-index.ts")
    if qdrant.count("console.error(`[knowledge] qdrant ${operation} failed:`") != 1:
        raise RuntimeError("Qdrant operation logger changed unexpectedly")
    if "[knowledge] qdrant request failed:" in qdrant:
        raise RuntimeError("duplicate generic Qdrant error logger remains")


def mutate_chat(repo: Path, mode: str) -> None:
    path = repo / "client/src/components/chat/chat-studio.tsx"
    backup = repo / ".pr58-chat-studio.backup"
    if mode == "apply":
        if backup.exists():
            raise RuntimeError("mutation backup already exists")
        shutil.copy2(path, backup)
        text = path.read_text(encoding="utf-8")
        old = "    mountedRef.current = true;\n    return () => {"
        new = "    return () => {"
        if text.count(old) != 1:
            raise RuntimeError("could not locate mountedRef StrictMode setup for mutation")
        path.write_text(text.replace(old, new, 1), encoding="utf-8")
    elif mode == "restore":
        if not backup.exists():
            raise RuntimeError("mutation backup missing")
        shutil.move(str(backup), str(path))
    else:
        raise ValueError(mode)


def commit_fixes(repo: Path) -> None:
    run(repo, "git", "add", "-A")
    run(repo, "git", "diff", "--cached", "--check")
    run(repo, "git", "commit", "-m", "fix: address PR #58 review findings")
    run(repo, "git", "log", "--oneline", "--decorate", "-5")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command",
        choices=[
            "integrate",
            "add-tests",
            "apply-fixes",
            "verify-static",
            "mutate-chat",
            "restore-chat",
            "commit",
        ],
    )
    parser.add_argument("repo")
    args = parser.parse_args()
    repo = Path(args.repo).resolve()

    if args.command == "integrate":
        integrate(repo)
    elif args.command == "add-tests":
        add_tests(repo)
    elif args.command == "apply-fixes":
        apply_fixes(repo)
    elif args.command == "verify-static":
        verify_static(repo)
    elif args.command == "mutate-chat":
        mutate_chat(repo, "apply")
    elif args.command == "restore-chat":
        mutate_chat(repo, "restore")
    elif args.command == "commit":
        commit_fixes(repo)


if __name__ == "__main__":
    main()
