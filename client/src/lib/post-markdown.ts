/**
 * Split a stored `post.md` blob into its canonical-unit and repurposed-caption
 * sections. Mirrors the delimiter contract from
 * `agent/src/mastra/social-content/canonical-unit.ts` → `wrapPostMarkdown`.
 *
 * Legacy posts written before the canonical contract have no delimiters and
 * fall back to a single caption panel — the whole file is treated as the
 * caption, with no canonical section.
 *
 * The parser lives in the client workspace (not imported from the agent
 * workspace) to respect the workspace boundary: the client never imports
 * agent-private modules per AGENTS.md.
 */
export function splitPostMarkdown(
  postMarkdown: string,
): { canonicalMarkdown?: string; captionMarkdown: string } {
  const canonicalMatch = postMarkdown.match(
    /<!--\s*canonical-unit\s*-->([\s\S]*?)<!--\s*\/canonical-unit\s*-->/,
  );
  const captionMatch = postMarkdown.match(
    /<!--\s*repurposed-caption\s*-->([\s\S]*?)<!--\s*\/repurposed-caption\s*-->/,
  );
  if (!canonicalMatch) {
    // Legacy post: no canonical contract, treat the whole file as caption.
    return { captionMarkdown: postMarkdown };
  }
  return {
    canonicalMarkdown: canonicalMatch[1]!.trim(),
    captionMarkdown: captionMatch ? captionMatch[1]!.trim() : '',
  };
}
