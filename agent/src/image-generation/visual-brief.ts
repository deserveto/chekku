import { z } from 'zod';

/**
 * Visual Brief — the structured contract between the Visual Content Agent and
 * the image-generation + compositing pipeline.
 *
 * Architecture (editorial pipeline upgrade):
 *
 *   ┌─────────────────────┐         ┌─────────────────────┐
 *   │ Visual Content Agent │  emits  │                     │
 *   │  (LLM orchestration) │ ──────► │   VisualBrief       │
 *   └─────────────────────┘         │   (this schema)     │
 *                                    └────────┬────────────┘
 *                                             │
 *                                             ▼
 *                                   ┌─────────────────────┐
 *                                   │ image-generation    │
 *                                   │ client (gateway)    │   pure visual,
 *                                   │ `imagePrompt` only  │   NO text/typography
 *                                   └────────┬────────────┘
 *                                            │ background PNG bytes
 *                                            ▼
 *                                   ┌─────────────────────┐
 *                                   │ compositor          │
 *                                   │ (canvas grid)       │   heroNumber +
 *                                   │                     │   headline +
 *                                   │                     │   facts grid +
 *                                   │                     │   source + logo
 *                                   └────────┬────────────┘
 *                                            │ final PNG bytes
 *                                            ▼
 *                                   ┌─────────────────────┐
 *                                   │ storage (Garage)    │
 *                                   └─────────────────────┘
 *
 * Why the split: the image-generation gateway is text-to-image only and is
 * unreliable at rendering legible typography, accurate numbers, or the brand
 * logo. The application layer (compositor) owns typography, fact layout,
 * hero number hook, source attribution, and the real Rafiqspace logo asset.
 * The image model contributes ONLY the visual/illustration/scene.
 *
 * Editorial visual hierarchy (LEVEL 1 = most prominent):
 *   LEVEL 1  heroNumber   (optional — strongest number from canonical, e.g. "360 MW")
 *   LEVEL 2  headline     (the canonical headline verbatim)
 *   LEVEL 3  hero image   (the generated background — full-bleed in middle zone)
 *   LEVEL 4  facts        (1–3 verified supporting facts in a grid)
 *   LEVEL 5  context      (optional editorial framing line)
 *   LEVEL 6  source       (understated source attribution)
 *   LEVEL 7  logo         (Rafiqspace AI brand signature, bottom-right by default)
 */

export const CONTENT_PILLAR_SCHEMA = z.enum(['CELEBRATION', 'TECHNOLOGY', 'GENERAL']);
export type ContentPillar = z.infer<typeof CONTENT_PILLAR_SCHEMA>;

export const LOGO_POSITION_SCHEMA = z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
export type LogoPosition = z.infer<typeof LOGO_POSITION_SCHEMA>;

/**
 * Pure-visual generation prompt. MUST describe only SUBJECT, ENVIRONMENT,
 * LIGHTING, COMPOSITION, MATERIAL, CAMERA, MOOD, STYLE. MUST request
 * cinematic, realistic editorial photography (like Bloomberg or WIRED covers).
 * MUST NOT request infographic styles, glass panels, dashboards, text, typography,
 * logos, watermark, brand names, fake UI, random letters,
 * gibberish, or factual overlays. The compositor owns every textual element.
 *
 * Bounded to 2,000 UTF-8 bytes by the tool schema (the underlying gateway
 * limit), but the brief SHOULD stay well under that — long visual prompts
 * also degrade model output.
 */
export const IMAGE_PROMPT_SCHEMA = z
  .string()
  .refine(
    (value) => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 2_000,
    'imagePrompt must be a non-empty string of at most 2,000 UTF-8 bytes.',
  );

/**
 * Hero number — the LEVEL 1 visual hook. Optional. When present, rendered as
 * the dominant typographic element at the top of the poster (e.g. "360 MW",
 * "170.000 GPU", "3 PUSAT DATA"). MUST be a short literal extracted from the
 * canonical content's verified facts — never invented, never strengthened.
 *
 * Omit when the canonical content has no decisive number (the layout adapts
 * and gives the headline the top anchor slot instead).
 */
export const HERO_NUMBER_SCHEMA = z
  .string()
  .refine(
    (value) => value.trim().length > 0 && value.length <= 24,
    'heroNumber must be a non-empty string of at most 24 characters (e.g. "360 MW", "170.000 GPU").',
  )
  .optional();

/**
 * Headline rendered on the final image. MUST come from the canonical content
 * (not invented by the Visual Agent). Bounded to a length that fits the
 * composition without overflow.
 */
export const HEADLINE_SCHEMA = z
  .string()
  .refine(
    (value) => value.trim().length > 0 && value.length <= 120,
    'headline must be a non-empty string of at most 120 characters.',
  )
  .refine(
    (value) => !/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu.test(value),
    'headline must NOT contain emojis. They cause rendering errors (boxes) on the premium cover.',
  );

/**
 * 1–3 verified facts. Each fact is a short statement that MUST be traceable to
 * a `Verified facts` entry in the Strategist's News Research Result. Each
 * fact is rendered as a single column in the bottom-zone facts grid.
 */
export const FACT_SCHEMA = z
  .string()
  .refine(
    (value) => value.trim().length > 0 && value.length <= 80,
    'each fact must be a non-empty string of at most 80 characters.',
  )
  .refine(
    (value) => !/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu.test(value),
    'facts must NOT contain emojis.',
  );

export const FACTS_SCHEMA = z
  .array(FACT_SCHEMA)
  .min(1, 'at least one verified fact is required.')
  .max(3, 'at most three verified facts fit the composition cleanly.');

/**
 * Optional editorial framing line — clearly an editorial voice, NOT a
 * factual statement. Rendered in a distinct style (italic, muted) so it
 * cannot be misread as fact.
 */
export const CONTEXT_SCHEMA = z
  .string()
  .refine(
    (value) => value.trim().length > 0 && value.length <= 140,
    'context must be a non-empty string of at most 140 characters.',
  )
  .refine(
    (value) => !/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu.test(value),
    'context must NOT contain emojis.',
  )
  .optional();

/**
 * Source attribution. MUST be assembled from the verified source object as
 * `Sumber: <sourceName>` or `Sumber: <sourceName> · <publishedAt>` (only
 * when the published date is verified). Empty string when the source is
 * unverified or when the content pillar is CELEBRATION.
 */
export const SOURCE_SCHEMA = z
  .string()
  .refine((value) => value.length <= 120, 'source must be at most 120 characters.');

export const VISUAL_BRIEF_SCHEMA = z
  .object({
    contentPillar: CONTENT_PILLAR_SCHEMA,
    imagePrompt: IMAGE_PROMPT_SCHEMA,
    heroNumber: HERO_NUMBER_SCHEMA,
    headline: HEADLINE_SCHEMA,
    facts: FACTS_SCHEMA,
    context: CONTEXT_SCHEMA,
    /**
     * Optional date string to be rendered as a date badge (e.g., for CELEBRATION).
     */
    date: z.string().optional(),
    source: SOURCE_SCHEMA,
    logoPosition: LOGO_POSITION_SCHEMA.default('bottom-right'),
    visualIdentity: z.string().optional(),
    artDirection: z.string().optional(),
    heroSubject: z.string().optional(),
    composition: z.string().optional(),
    lighting: z.string().optional(),
    cameraDirection: z.string().optional(),
    typographyStyle: z.string().optional(),
    informationHierarchy: z.string().optional(),
    decorativeElements: z.string().optional(),
    forbiddenElements: z.string().optional(),
  })
  .strict();

export type VisualBrief = z.infer<typeof VISUAL_BRIEF_SCHEMA>;

/**
 * Compositor configuration. Internal (not exposed via the tool schema) —
 * derived from the brief at compose time. Kept as a separate type so the
 * compositor is fully deterministic given (brief, backgroundBytes, logoBytes).
 *
 * All ratios are expressed against a 1024×1024 reference canvas; the
 * compositor scales them linearly for other canvas sizes.
 */
export interface CompositionPlan {
  width: number;
  height: number;
  /** Pixel safe margin from every canvas edge (~5.5% of width). Elements never enter this margin. */
  safeMargin: number;
  /** Pixel height of the top zone (hero number + headline + context). Larger when heroNumber is present. */
  topZoneHeight: number;
  /** Pixel height of the bottom zone (facts grid + source + logo). */
  bottomZoneHeight: number;
  /** Background colour for the top and bottom zones (the middle zone is the generated visual). */
  frameColor: string;
  /** Optional wash colour laid behind the hero image if it does not fully cover the middle zone. */
  middleBgColor: string;
  /** Primary text colour for hero number, headline, fact values. */
  textColor: string;
  /** Muted text colour for context, source. */
  mutedTextColor: string;
  /** Accent colour for the hero number, fact labels, divider strokes. */
  accentColor: string;
  /** Pixel edge size of the logo mark (square aspect, preserved). */
  logoSize: number;
}

/**
 * Editorial palette per content pillar.
 *
 * TECHNOLOGY  — deep navy + cyan accent, premium technology magazine (WIRED /
 *               The Verge), NOT cyberpunk/gaming poster.
 * GENERAL     — slate + blue accent, contemporary editorial.
 * CELEBRATION — cream + gold accent, warm editorial.
 */
export interface CompositionPlanDefaults {
  /** Safe margin as a fraction of canvas width (e.g. 0.055 = 5.5%). */
  safeMarginRatio: number;
  /** Top-zone height as a fraction of canvas height, when heroNumber is present. */
  topZoneRatioWithHero: number;
  /** Top-zone height as a fraction of canvas height, when heroNumber is absent. */
  topZoneRatioWithoutHero: number;
  /** Bottom-zone height as a fraction of canvas height. */
  bottomZoneRatio: number;
  /** Logo edge size as a fraction of canvas width. */
  logoSizeRatio: number;
  frameColor: string;
  middleBgColor: string;
  textColor: string;
  mutedTextColor: string;
  accentColor: string;
}

export const COMPOSITION_PLAN_DEFAULTS: Record<ContentPillar, CompositionPlanDefaults> = {
  TECHNOLOGY: {
    safeMarginRatio: 0.055,
    topZoneRatioWithHero: 0.34,
    topZoneRatioWithoutHero: 0.22,
    bottomZoneRatio: 0.26,
    logoSizeRatio: 0.075,
    frameColor: '#0a1628',
    middleBgColor: '#050d1c',
    textColor: '#f4f6fb',
    mutedTextColor: '#7c8aa5',
    accentColor: '#22d3ee',
  },
  GENERAL: {
    safeMarginRatio: 0.055,
    topZoneRatioWithHero: 0.34,
    topZoneRatioWithoutHero: 0.22,
    bottomZoneRatio: 0.26,
    logoSizeRatio: 0.075,
    frameColor: '#152033',
    middleBgColor: '#0c1422',
    textColor: '#f4f6fb',
    mutedTextColor: '#8a96ad',
    accentColor: '#3b82f6',
  },
  CELEBRATION: {
    safeMarginRatio: 0.055,
    topZoneRatioWithHero: 0.32,
    topZoneRatioWithoutHero: 0.22,
    bottomZoneRatio: 0.26,
    logoSizeRatio: 0.08,
    frameColor: '#f7f3ec',
    middleBgColor: '#ece5d5',
    textColor: '#0a1628',
    mutedTextColor: '#6b7280',
    accentColor: '#b8893a',
  },
} as const;

/**
 * Legacy compatibility: previous COMPOSITION_PLANS shape. Some tests and
 * downstream code still reference the old field set; this wraps the new
 * defaults into the old plan interface at the 1024 reference canvas size.
 */
export const COMPOSITION_PLANS: Record<ContentPillar, Omit<CompositionPlan, 'width' | 'height' | 'safeMargin' | 'topZoneHeight' | 'bottomZoneHeight'> & {
  headerHeight: number;
  footerHeight: number;
  padding: number;
}> = {
  TECHNOLOGY: {
    frameColor: COMPOSITION_PLAN_DEFAULTS.TECHNOLOGY.frameColor,
    middleBgColor: COMPOSITION_PLAN_DEFAULTS.TECHNOLOGY.middleBgColor,
    textColor: COMPOSITION_PLAN_DEFAULTS.TECHNOLOGY.textColor,
    mutedTextColor: COMPOSITION_PLAN_DEFAULTS.TECHNOLOGY.mutedTextColor,
    accentColor: COMPOSITION_PLAN_DEFAULTS.TECHNOLOGY.accentColor,
    logoSize: Math.round(1024 * COMPOSITION_PLAN_DEFAULTS.TECHNOLOGY.logoSizeRatio),
    headerHeight: Math.round(1024 * COMPOSITION_PLAN_DEFAULTS.TECHNOLOGY.topZoneRatioWithHero),
    footerHeight: Math.round(1024 * COMPOSITION_PLAN_DEFAULTS.TECHNOLOGY.bottomZoneRatio),
    padding: Math.round(1024 * COMPOSITION_PLAN_DEFAULTS.TECHNOLOGY.safeMarginRatio),
  },
  GENERAL: {
    frameColor: COMPOSITION_PLAN_DEFAULTS.GENERAL.frameColor,
    middleBgColor: COMPOSITION_PLAN_DEFAULTS.GENERAL.middleBgColor,
    textColor: COMPOSITION_PLAN_DEFAULTS.GENERAL.textColor,
    mutedTextColor: COMPOSITION_PLAN_DEFAULTS.GENERAL.mutedTextColor,
    accentColor: COMPOSITION_PLAN_DEFAULTS.GENERAL.accentColor,
    logoSize: Math.round(1024 * COMPOSITION_PLAN_DEFAULTS.GENERAL.logoSizeRatio),
    headerHeight: Math.round(1024 * COMPOSITION_PLAN_DEFAULTS.GENERAL.topZoneRatioWithHero),
    footerHeight: Math.round(1024 * COMPOSITION_PLAN_DEFAULTS.GENERAL.bottomZoneRatio),
    padding: Math.round(1024 * COMPOSITION_PLAN_DEFAULTS.GENERAL.safeMarginRatio),
  },
  CELEBRATION: {
    frameColor: COMPOSITION_PLAN_DEFAULTS.CELEBRATION.frameColor,
    middleBgColor: COMPOSITION_PLAN_DEFAULTS.CELEBRATION.middleBgColor,
    textColor: COMPOSITION_PLAN_DEFAULTS.CELEBRATION.textColor,
    mutedTextColor: COMPOSITION_PLAN_DEFAULTS.CELEBRATION.mutedTextColor,
    accentColor: COMPOSITION_PLAN_DEFAULTS.CELEBRATION.accentColor,
    logoSize: Math.round(1024 * COMPOSITION_PLAN_DEFAULTS.CELEBRATION.logoSizeRatio),
    headerHeight: Math.round(1024 * COMPOSITION_PLAN_DEFAULTS.CELEBRATION.topZoneRatioWithHero),
    footerHeight: Math.round(1024 * COMPOSITION_PLAN_DEFAULTS.CELEBRATION.bottomZoneRatio),
    padding: Math.round(1024 * COMPOSITION_PLAN_DEFAULTS.CELEBRATION.safeMarginRatio),
  },
} as const;
