import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { clampToWidth, composeVisual, loadBrandLogoBytes, resolveBrandLogoPath, __resetBrandLogoCacheForTests, BRAND_LOGO_RELATIVE_PATH } from './compositor.js';
import { COMPOSITION_PLANS, type VisualBrief } from './visual-brief.js';

const TEST_LOGO_PATH = 'agent/src/assets/__test-logo.png';

function makeBrief(overrides: Partial<VisualBrief> = {}): VisualBrief {
  return {
    contentPillar: 'TECHNOLOGY',
    imagePrompt: 'irrelevant — compositor does not call the image model',
    headline: '170.000 GPU di Batam: Indonesia Sedang Bangun Otot AI',
    facts: ['170.000 AI accelerators', '360 MW planned capacity', 'Q1 2027 initial target'],
    source: 'Sumber: detikInet · 9 Agustus 2026',
    logoPosition: 'bottom-right',
    ...overrides,
  };
}

/**
 * Produce a synthetic PNG background of the given size so we can exercise the
 * compositor end-to-end without calling the image-generation gateway. The
 * PNG is a solid colour rectangle with a distinguishing byte pattern that we
 * can later verify DID get drawn over (compositor must replace the entire
 * frame with the composed result).
 */
async function syntheticBackground(width: number, height: number, hex: string): Promise<Uint8Array> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, width, height);
  return new Uint8Array(canvas.toBuffer('image/png'));
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const;

describe('compositor — brand asset resolver', () => {
  it('exposes the brand-logo relative path', () => {
    expect(BRAND_LOGO_RELATIVE_PATH).toBe('src/assets/image.png');
  });

  it('resolves an explicit override path without falling back to the file system', () => {
    const resolved = resolveBrandLogoPath(TEST_LOGO_PATH);
    expect(resolved).toBe(TEST_LOGO_PATH);
  });

  it('loads bytes from an explicit override path', () => {
    const bytes = loadBrandLogoBytes(TEST_LOGO_PATH);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
  });

  it('throws a fixed safe error when the override path does not exist', () => {
    expect(() => loadBrandLogoBytes('agent/src/assets/__does-not-exist.png')).toThrow();
  });

  it('walks up from a nested CWD to find the real brand logo (regression: mastra dev sets CWD deep inside the agent workspace)', () => {
    // The real logo lives at agent/src/assets/image.png (relative to repo root).
    // mastra dev has been observed running tool execute with CWD set deep inside
    // the agent workspace. The resolver must walk up the directory tree and
    // find the logo regardless of CWD depth. The nested directory is derived
    // from THIS test file's own location so the regression always runs — an
    // existsSync-guarded fixture path silently self-skips when the fixture is
    // absent, which is exactly what happened with agent/src/mastra/public.
    const originalCwd = process.cwd();
    const nestedDir = dirname(fileURLToPath(import.meta.url));
    expect(existsSync(nestedDir)).toBe(true);
    try {
      process.chdir(nestedDir);
      __resetBrandLogoCacheForTests();
      const resolved = resolveBrandLogoPath();
      expect(resolved).toContain('image.png');
      const bytes = loadBrandLogoBytes();
      expect(bytes.byteLength).toBeGreaterThan(1000); // real logo is ~200 KB
      expect(bytes[0]).toBe(0x89); // PNG magic
    } finally {
      process.chdir(originalCwd);
      __resetBrandLogoCacheForTests();
    }
  });
});

describe('compositor — composeVisual', () => {
  it('returns a real PNG (magic bytes) at the requested canvas size', async () => {
    const bg = await syntheticBackground(1024, 1024, '#0a1628');
    const logo = readFileSync(resolve(TEST_LOGO_PATH));
    const composed = await composeVisual({
      brief: makeBrief(),
      backgroundBytes: bg,
      logoBytes: new Uint8Array(logo),
      canvasSize: 512,
    });

    expect(composed.byteLength).toBeGreaterThan(0);
    expect(composed[0]).toBe(PNG_MAGIC[0]);
    expect(composed[1]).toBe(PNG_MAGIC[1]);
    expect(composed[2]).toBe(PNG_MAGIC[2]);
    expect(composed[3]).toBe(PNG_MAGIC[3]);
  });

  it('produces a deterministic output for the same inputs', async () => {
    const bg = await syntheticBackground(1024, 1024, '#0a1628');
    const logo = readFileSync(resolve(TEST_LOGO_PATH));

    const run = () => composeVisual({
      brief: makeBrief(),
      backgroundBytes: bg,
      logoBytes: new Uint8Array(logo),
      canvasSize: 256,
    });

    const a = await run();
    const b = await run();
    expect(a.byteLength).toBe(b.byteLength);
    // Byte-for-byte equality on a deterministic render.
    for (let i = 0; i < a.byteLength; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });

  it('applies different palettes per content pillar (TECHNOLOGY dark navy, CELEBRATION light)', async () => {
    const bg = await syntheticBackground(1024, 1024, '#000000');
    const logo = readFileSync(resolve(TEST_LOGO_PATH));

    const techBytes = await composeVisual({
      brief: makeBrief({ contentPillar: 'TECHNOLOGY' }),
      backgroundBytes: bg,
      logoBytes: new Uint8Array(logo),
      canvasSize: 512,
    });
    const celebBytes = await composeVisual({
      brief: makeBrief({ contentPillar: 'CELEBRATION' }),
      backgroundBytes: bg,
      logoBytes: new Uint8Array(logo),
      canvasSize: 512,
    });

    // Both must be valid PNGs.
    expect(techBytes[0]).toBe(0x89);
    expect(celebBytes[0]).toBe(0x89);
    // The byte streams differ because the header/footer palettes differ.
    expect(techBytes).not.toEqual(celebBytes);
  });

  it('handles 1, 2, or 3 facts without overflowing the footer', async () => {
    const bg = await syntheticBackground(1024, 1024, '#0a1628');
    const logo = readFileSync(resolve(TEST_LOGO_PATH));

    for (const factCount of [1, 2, 3]) {
      const facts = Array.from({ length: factCount }, (_, i) => `Fact ${i + 1}: short`);
      const composed = await composeVisual({
        brief: makeBrief({ facts }),
        backgroundBytes: bg,
        logoBytes: new Uint8Array(logo),
        canvasSize: 512,
      });
      expect(composed.byteLength).toBeGreaterThan(0);
      expect(composed[0]).toBe(0x89);
    }
  });

  it('clamps every wrapped line to its column width with an ellipsis (no silent canvas-edge clipping)', async () => {
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(1024, 256);
    const ctx = canvas.getContext('2d');
    ctx.font = '900 77px sans-serif';

    // A schema-valid 120-char headline far exceeds the ~594px headline column
    // at this font; the clamp must return an ellipsized string that fits.
    const longHeadline = 'Indonesia Sedang Membangun Otot AI Nasional Terbesar di Asia Tenggara Dengan Investasi Puluhan Triliun Rupiah dan Ribuan GPU';
    const maxWidth = 1024 * 0.58;
    const clamped = clampToWidth(ctx, longHeadline, maxWidth);
    expect(clamped.endsWith('…')).toBe(true);
    expect(clamped.length).toBeLessThan(longHeadline.length);
    expect(ctx.measureText(clamped).width).toBeLessThanOrEqual(maxWidth);

    // A fitting string passes through unchanged.
    expect(clampToWidth(ctx, 'AI Factory di Batam', maxWidth)).toBe('AI Factory di Batam');

    // A degenerate zero-width column never returns unbounded text.
    expect(clampToWidth(ctx, 'anything', 0)).toBe('');
  });

  it('still composes a valid PNG when the headline exceeds the layout zone', async () => {
    const bg = await syntheticBackground(1024, 1024, '#0a1628');
    const logo = readFileSync(resolve(TEST_LOGO_PATH));
    const composed = await composeVisual({
      brief: makeBrief({
        headline:
          'Indonesia Sedang Membangun Otot AI Nasional Terbesar di Asia Tenggara Dengan Investasi Puluhan Triliun Rupiah dan Ribuan GPU Modern di Beberapa Provinsi',
        facts: [
          '170.000 AI accelerators dalam satu fase pembangunan awal yang sangat besar',
          '360 MW rencana kapasitas listrik untuk mendukung operasional penuh fasilitas',
          'Q1 2027 target operasional awal dengan skala ekspansi berkelanjutan bertahap',
        ],
      }),
      backgroundBytes: bg,
      logoBytes: new Uint8Array(logo),
      canvasSize: 1024,
    });
    expect(composed.byteLength).toBeGreaterThan(0);
    expect(composed[0]).toBe(0x89);
  });

  it('renders without a source line when the brief source is empty (celebration pillar)', async () => {
    const bg = await syntheticBackground(1024, 1024, '#10233f');
    const logo = readFileSync(resolve(TEST_LOGO_PATH));
    const composed = await composeVisual({
      brief: makeBrief({ contentPillar: 'CELEBRATION', source: '' }),
      backgroundBytes: bg,
      logoBytes: new Uint8Array(logo),
      canvasSize: 512,
    });
    expect(composed.byteLength).toBeGreaterThan(0);
  });

  it('renders the hero number as the LEVEL 1 visual hook when present (large number variant)', async () => {
    const bg = await syntheticBackground(1024, 1024, '#0a1628');
    const logo = readFileSync(resolve(TEST_LOGO_PATH));
    const composed = await composeVisual({
      brief: makeBrief({ heroNumber: '170.000 GPU' }),
      backgroundBytes: bg,
      logoBytes: new Uint8Array(logo),
      canvasSize: 512,
    });
    expect(composed.byteLength).toBeGreaterThan(0);
    expect(composed[0]).toBe(0x89);
  });

  it('renders the hero number for short capacity variants (360 MW)', async () => {
    const bg = await syntheticBackground(1024, 1024, '#0a1628');
    const logo = readFileSync(resolve(TEST_LOGO_PATH));
    const composed = await composeVisual({
      brief: makeBrief({ heroNumber: '360 MW', headline: 'CoreWeave Bangun 3 Pusat Data AI di Indonesia' }),
      backgroundBytes: bg,
      logoBytes: new Uint8Array(logo),
      canvasSize: 512,
    });
    expect(composed.byteLength).toBeGreaterThan(0);
    expect(composed[0]).toBe(0x89);
  });

  it('adapts the layout when heroNumber is absent (news without a decisive number)', async () => {
    const bg = await syntheticBackground(1024, 1024, '#0a1628');
    const logo = readFileSync(resolve(TEST_LOGO_PATH));
    const withoutHero = await composeVisual({
      brief: makeBrief({}),
      backgroundBytes: bg,
      logoBytes: new Uint8Array(logo),
      canvasSize: 512,
    });
    const withHero = await composeVisual({
      brief: makeBrief({ heroNumber: '360 MW' }),
      backgroundBytes: bg,
      logoBytes: new Uint8Array(logo),
      canvasSize: 512,
    });
    // Both renders succeed and produce PNGs.
    expect(withoutHero[0]).toBe(0x89);
    expect(withHero[0]).toBe(0x89);
    // Byte content differs because the top-zone layout adapts (larger top zone
    // when heroNumber is present, smaller when absent).
    expect(withoutHero).not.toEqual(withHero);
  });

  it('renders the optional editorial context line when provided', async () => {
    const bg = await syntheticBackground(1024, 1024, '#0a1628');
    const logo = readFileSync(resolve(TEST_LOGO_PATH));
    const composed = await composeVisual({
      brief: makeBrief({ context: 'AI bukan hanya soal model — ia membutuhkan otot komputasi fisik.' }),
      backgroundBytes: bg,
      logoBytes: new Uint8Array(logo),
      canvasSize: 512,
    });
    expect(composed.byteLength).toBeGreaterThan(0);
  });
});

describe('compositor — composition plan defaults', () => {
  it('defines plans for CELEBRATION, TECHNOLOGY, GENERAL', () => {
    expect(COMPOSITION_PLANS.CELEBRATION.frameColor).toBe('#f7f3ec');
    expect(COMPOSITION_PLANS.TECHNOLOGY.frameColor).toBe('#0a1628');
    expect(COMPOSITION_PLANS.GENERAL.frameColor).toBe('#152033');
  });

  it('uses cyan accent for TECHNOLOGY and gold accent for CELEBRATION', () => {
    expect(COMPOSITION_PLANS.TECHNOLOGY.accentColor).toBe('#22d3ee');
    expect(COMPOSITION_PLANS.CELEBRATION.accentColor).toBe('#b8893a');
  });
});
