/**
 * Canonical Content Unit — the platform-agnostic output contract of the
 * Social Media Content Writer.
 *
 * Per `PROMPT.md` (Notulensi Meeting Week 4 N4_5, 24 Juli 2026), the Content
 * Writer's primary output is no longer a platform-specific caption. It is a
 * canonical content unit: a structured, semi-raw piece of content that can be
 * repurposed to many platforms (Instagram, LinkedIn, X, TikTok, Medium) via
 * downstream prompt engineering.
 *
 * Anatomy (matches PROMPT.md:121-146):
 *
 *   [TOPIC]                         — the subject, one line
 *   [THESIS]                        — the angle / point of view, one paragraph
 *   HOOKS (3)                       — Curiosity, Contrarian, Data/Impact angles
 *   CORE POINTS                     — 3-5 bullets, the substance
 *   SHORT-FORM BRICK                — X / TikTok caption (≤280 chars body)
 *   MEDIUM-FORM BRICK               — LinkedIn / Medium article body
 *   VISUAL / VIDEO SCRIPT BRICK     — platform-agnostic sequence of reusable visual concepts
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
  visualScriptBrick: string;
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

VISUAL / VIDEO SCRIPT BRICK
<Platform-agnostic visual narrative — a sequence of reusable visual concepts, NOT a finalized platform-specific layout. Do NOT label items "Panel 1 / Panel 2 / …"; write a flowing sequence of visual concepts arranged as a coherent story: Problem (if applicable) → key event or innovation → impact or recognition → future implication (only if supported by the content). Use only the minimum number of concepts needed (simple news ≈ 3, medium topic ≈ 4, complex educational topic ≈ 5+ only when necessary; fewer or more allowed when justified); never split one idea across multiple concepts when one concept can carry it. Each concept contains exactly three elements and nothing else — Purpose, Visual, Overlay:
- Purpose: the communication objective — WHY this visual exists, not its position in the sequence. Never use generic labels such as "Introduction", "Core News", "Future Outlook", or "Closing". Write descriptive aims, e.g. "Highlight the healthcare accessibility problem", "Introduce the Home Care innovation", "Show government recognition", "Explain the national impact", "Present the future direction".
- Visual: prioritize concrete scenes depicting the real event, action, or situation (e.g. healthcare workers visiting a patient's home, a patient receiving treatment at home, medical staff interacting with families, community healthcare activities). Do NOT default to symbolic assets — logos, maps, icons, abstract graphics — unless they are truly the central subject of the news; they may support a scene but must not replace it when a real-world scene communicates the message better.
- Overlay: short and memorable, 3–8 words (max ~10). Never a full sentence. Example: "Home Care Jemput Bola", "Diapresiasi Kemenkes RI", "Menuju Model Nasional".
Ground every visual in the source / Core Points — never invent speculative or inferred imagery (if the source only mentions international healthcare cooperation, draw "illustration of international healthcare collaboration", not "futuristic telemedicine UI"). Do NOT include camera direction, scene movement, animation, transition effects, voice-over, audio cues, or editing instructions, and do NOT describe the concepts using platform-specific presentation wording such as "carousel", "slide", or "reel" — downstream platform-specific agents decide how many cards are needed and how they are presented.>

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

  lines.push('VISUAL / VIDEO SCRIPT BRICK');
  lines.push(unit.visualScriptBrick.trim());
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
    visualScriptBrick: extractSection(markdown, 'VISUAL / VIDEO SCRIPT BRICK') ?? '',
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
