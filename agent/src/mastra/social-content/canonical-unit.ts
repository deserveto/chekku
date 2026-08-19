/**
 * Canonical Content Unit — 8 Blocks — the platform-agnostic output contract of
 * the Social Media Content Writer.
 *
 * Per `PROMPT.md` (Notulensi Meeting Week 4 N4_5, 24 Juli 2026), the Content
 * Writer's primary output is no longer a platform-specific caption. It is a
 * canonical content unit: a structured, semi-raw piece of content that can be
 * repurposed to many platforms (Instagram, LinkedIn, X, TikTok, Medium) via
 * downstream prompt engineering.
 *
 * Anatomy (8 Blocks — matches PROMPT.md:121-146):
 *
 *   [TOPIC]                         — the subject, one line
 *   [THESIS]                        — the angle / point of view, one paragraph
 *   HOOKS (3)                       — Curiosity, Contrarian, Data/Impact angles
 *   CORE POINTS                     — 3-5 bullets, the substance
 *   SHORT-FORM BRICK                — X / TikTok caption (≤280 chars body)
 *   MEDIUM-FORM BRICK               — LinkedIn / Medium article body
 *   IMAGE BRICK                     — platform-agnostic 1:1 poster/infographic composition (text + graphic panels)
 *   CALL TO ACTION / ENGAGEMENT     — one closing CTA
 *
 * Storage (per AGENTS.md invariant): `post.md` in Garage stores the rendered
 * canonical markdown, optionally followed by a repurposed platform caption
 * under a `<!-- repurposed-caption -->` HTML comment delimiter. The metadata
 * schema (`SocialPostMetadata`) is unchanged — the canonical unit is just
 * markdown text.
 */

export interface CanonicalHooks {
  curiosity: string;
  contrarian: string;
  dataImpact: string;
}

export interface CanonicalContentUnit {
  topic: string;
  thesis: string;
  hooks: CanonicalHooks;
  corePoints: string[];
  shortFormBrick: string;
  mediumFormBrick: string;
  imageBrick: string;
  callToAction: string;
}

/**
 * Markdown section markers. These are stable strings the parser looks for;
 * changing them is a breaking change for any `post.md` already stored in
 * Garage under the social-posts namespace.
 */
export const CANONICAL_UNIT_SECTION = 'canonical-unit';
export const REPURPOSED_CAPTION_SECTION = 'repurposed-caption';

/**
 * Open/close HTML comment delimiters used to embed structured sections in
 * `post.md`. HTML comments are invisible when the file is rendered as
 * Markdown, so legacy readers that don't know about the canonical contract
 * still produce readable output (the whole file is shown as Markdown).
 */
export function sectionOpen(name: string): string {
  return `<!-- ${name} -->`;
}

export function sectionClose(name: string): string {
  return `<!-- /${name} -->`;
}

/**
 * Markdown template skeleton emitted in draft prompts so the LLM has a
 * concrete shape to fill. Kept in sync with {@link renderCanonicalUnit}.
 */
export const CANONICAL_UNIT_TEMPLATE = `[TOPIC]
<one-line subject of this content>

[THESIS]
<one paragraph — the angle or point of view that makes this content worth reading. Not a summary; the POV.>

HOOKS
1. Curiosity: <"The X that did Y…" — opens a knowledge gap>
2. Contrarian: <"Stop doing X…" — challenges a default assumption>
3. Data/Impact: <"70% of X is Y. Here is the framework:" — leads with a number or outcome>

CORE POINTS
- <one substantive point, one line>
- <one substantive point, one line>
- <one substantive point, one line>

SHORT-FORM BRICK
<X / TikTok caption. Hook in the first line, ≤280 characters body, 1-3 hashtags max.>

MEDIUM-FORM BRICK
<LinkedIn / Medium post body. Professional voice, short paragraphs, one clear idea. Keep it factual: do not state guaranteed impact or outcomes unless the source explicitly supports them — prefer hedged wording ("diharapkan…", "berpotensi…", "ditujukan untuk…", "menjadi langkah menuju…") over definitive claims.>

IMAGE BRICK
<Platform-agnostic 1:1 image composition — a designed poster/infographic (NOT a bare photograph and NOT a video script). Arrange the content as one or more panels inside a single 1:1 image; use only as many panels as the content needs. Each panel contains exactly:
- Purpose: the communication objective — WHY this panel exists.
- hero object: the central subject.
- environment: setting, scale.
- emotional goal: mood, tone.
- composition: framing, perspective.
- supporting elements: decorative/material context.
- negative constraints: what must NOT be included.
- Overlay: the ACTUAL TEXT drawn from this Canonical Content Unit that appears on the panel (keep it concise, roughly max ~12 words).
Ground every panel in the source / Core Points — never invent speculative imagery or claims. Do NOT include camera direction, scene movement, animation, transition effects, voice-over, audio cues, or any video/editing instructions — this is a static image only. Do NOT describe the concepts using platform-specific presentation wording such as "carousel", "slide", or "reel".>

CALL TO ACTION / ENGAGEMENT
<one line — what the reader should do, think, or reply next>`;

/**
 * Render a canonical content unit as Markdown. Output is deterministic and
 * mirrors {@link CANONICAL_UNIT_TEMPLATE}. Empty optional fields are omitted
 * rather than emitting empty headers, so partial LLM output still renders
 * cleanly.
 */
export function renderCanonicalUnit(unit: CanonicalContentUnit): string {
  const lines: string[] = [];

  lines.push('[TOPIC]');
  lines.push(unit.topic.trim());
  lines.push('');

  lines.push('[THESIS]');
  lines.push(unit.thesis.trim());
  lines.push('');

  lines.push('HOOKS');
  if (unit.hooks.curiosity.trim()) lines.push(`1. Curiosity: ${unit.hooks.curiosity.trim()}`);
  if (unit.hooks.contrarian.trim()) lines.push(`2. Contrarian: ${unit.hooks.contrarian.trim()}`);
  if (unit.hooks.dataImpact.trim()) lines.push(`3. Data/Impact: ${unit.hooks.dataImpact.trim()}`);
  lines.push('');

  lines.push('CORE POINTS');
  for (const point of unit.corePoints) {
    const trimmed = point.trim();
    if (trimmed) lines.push(`- ${trimmed}`);
  }
  lines.push('');

  lines.push('SHORT-FORM BRICK');
  lines.push(unit.shortFormBrick.trim());
  lines.push('');

  lines.push('MEDIUM-FORM BRICK');
  lines.push(unit.mediumFormBrick.trim());
  lines.push('');

  lines.push('IMAGE BRICK');
  lines.push(unit.imageBrick.trim());
  lines.push('');

  lines.push('CALL TO ACTION / ENGAGEMENT');
  lines.push(unit.callToAction.trim());

  return lines.join('\n');
}

/**
 * Best-effort parser: extract a canonical content unit from a Markdown blob.
 * Returns `undefined` when at least the [TOPIC] and [THESIS] sections cannot
 * be located. Missing optional sections become empty strings / empty arrays.
 *
 * Used by:
 * - The repurpose step in the weekly workflow, which needs the structured
 *   unit to feed the platform-caption prompt.
 * - The client reader (future) to render the unit as structured UI panels.
 */
export function parseCanonicalUnit(markdown: string): CanonicalContentUnit | undefined {
  if (!markdown) return undefined;

  const topic = extractSection(markdown, 'TOPIC');
  const thesis = extractSection(markdown, 'THESIS');
  if (topic === undefined || thesis === undefined) return undefined;

  const hooksBlock = extractSection(markdown, 'HOOKS') ?? '';
  const hooks: CanonicalHooks = {
    curiosity: extractHook(hooksBlock, 'Curiosity'),
    contrarian: extractHook(hooksBlock, 'Contrarian'),
    dataImpact: extractHook(hooksBlock, 'Data/Impact') || extractHook(hooksBlock, 'Data'),
  };

  const coreBlock = extractSection(markdown, 'CORE POINTS') ?? '';
  const corePoints = coreBlock
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter((line) => line.length > 0);

  return {
    topic,
    thesis,
    hooks,
    corePoints,
    shortFormBrick: extractSection(markdown, 'SHORT-FORM BRICK') ?? '',
    mediumFormBrick: extractSection(markdown, 'MEDIUM-FORM BRICK') ?? '',
    // New canonical contract emits IMAGE BRICK. Fall back to the legacy
    // VISUAL / VIDEO SCRIPT BRICK header so post.md files written before the
    // image-only refactor still parse (the renderer emits the new header).
    imageBrick:
      extractSection(markdown, 'IMAGE BRICK')
      ?? extractSection(markdown, 'VISUAL / VIDEO SCRIPT BRICK')
      ?? '',
    callToAction: extractSection(markdown, 'CALL TO ACTION / ENGAGEMENT') ?? '',
  };
}

/**
 * Wrap a canonical unit (and optional repurposed caption) into a single
 * Markdown blob for storage in `post.md`. Sections are delimited by HTML
 * comment markers so legacy readers still render the file as readable
 * Markdown, while aware readers can split it into the canonical unit and the
 * derived platform caption.
 *
 * Layout:
 *
 *   <!-- canonical-unit -->
 *   <rendered canonical unit markdown>
 *   <!-- /canonical-unit -->
 *   <!-- repurposed-caption -->
 *   <caption markdown>
 *   <!-- /repurposed-caption -->
 */
export function wrapPostMarkdown(
  canonicalMarkdown: string,
  repurposedCaption: string | undefined,
): string {
  const parts: string[] = [];
  parts.push(sectionOpen(CANONICAL_UNIT_SECTION));
  parts.push(canonicalMarkdown.trim());
  parts.push(sectionClose(CANONICAL_UNIT_SECTION));
  if (repurposedCaption && repurposedCaption.trim().length > 0) {
    parts.push('');
    parts.push(sectionOpen(REPURPOSED_CAPTION_SECTION));
    parts.push(repurposedCaption.trim());
    parts.push(sectionClose(REPURPOSED_CAPTION_SECTION));
  }
  return parts.join('\n');
}

/**
 * Split a stored `post.md` blob back into its canonical unit markdown and
 * the optional repurposed caption markdown.
 *
 * Legacy fallback: posts written before the canonical contract have no
 * delimiters and are plain captions, so the whole file is returned as the
 * repurposed caption (and `canonicalMarkdown` is `undefined`). This mirrors
 * the client reader (`splitPostMarkdown` in
 * `client/src/app/social-posts/[postId]/page.tsx`) so both sides agree that
 * every pre-contract `post.md` is a caption, never a canonical unit.
 */
export function unwrapPostMarkdown(
  postMarkdown: string,
): { canonicalMarkdown: string | undefined; repurposedCaption: string | undefined } {
  const canonical = extractHtmlCommentBlock(postMarkdown, CANONICAL_UNIT_SECTION);
  if (canonical === undefined) {
    return { canonicalMarkdown: undefined, repurposedCaption: postMarkdown };
  }
  return {
    canonicalMarkdown: canonical,
    repurposedCaption: extractHtmlCommentBlock(postMarkdown, REPURPOSED_CAPTION_SECTION),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SECTION_HEADERS: readonly string[] = [
  '[TOPIC]',
  '[THESIS]',
  'HOOKS',
  'CORE POINTS',
  'SHORT-FORM BRICK',
  'MEDIUM-FORM BRICK',
  'IMAGE BRICK',
  // Legacy header kept so extractSection terminates correctly when parsing a
  // post.md written before the image-only refactor.
  'VISUAL / VIDEO SCRIPT BRICK',
  'CALL TO ACTION / ENGAGEMENT',
];

function extractSection(markdown: string, name: string): string | undefined {
  const header = name.startsWith('[') ? name : `[${name}]`;
  const headerAlt = name.startsWith('[') ? name.slice(1, -1) : name;
  const headerMatchAlt = headerAlt.toUpperCase();

  const lines = markdown.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (
      trimmed.toUpperCase() === header.toUpperCase() ||
      trimmed.toUpperCase() === headerMatchAlt
    ) {
      startIdx = i + 1;
      break;
    }
  }
  if (startIdx === -1) return undefined;

  const body: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (SECTION_HEADERS.some((h) => h.toUpperCase() === trimmed.toUpperCase())) break;
    body.push(lines[i]!);
  }

  const text = body.join('\n').trim();
  return text.length > 0 ? text : '';
}

function extractHook(block: string, label: string): string {
  const re = new RegExp(`^\\s*\\d+\\.\\s*${escapeRegex(label)}\\s*:\\s*(.+)$`, 'im');
  const match = re.exec(block);
  return match ? match[1]!.trim() : '';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractHtmlCommentBlock(markdown: string, name: string): string | undefined {
  const open = sectionOpen(name);
  const close = sectionClose(name);
  const start = markdown.indexOf(open);
  if (start === -1) return undefined;
  const end = markdown.indexOf(close, start);
  if (end === -1) return undefined;
  return markdown.slice(start + open.length, end).trim();
}
