import { createCanvas, GlobalFonts, loadImage, type Canvas, type SKRSContext2D, type Image } from '@napi-rs/canvas';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  COMPOSITION_PLAN_DEFAULTS,
  type CompositionPlan,
  type ContentPillar,
  type LogoPosition,
  type VisualBrief,
} from './visual-brief.js';

export const BRAND_LOGO_RELATIVE_PATH = 'src/assets/image.png';
const BRAND_LOGO_FILENAME = 'image.png';
const MAX_WALK_UP = 15;

let cachedLogoBytes: Uint8Array | undefined;

export function resolveBrandLogoPath(pathOverride?: string): string {
  if (pathOverride) return pathOverride;
  let dir = process.cwd();
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const agentLayout = join(dir, 'src', 'assets', BRAND_LOGO_FILENAME);
    if (existsSync(agentLayout)) return agentLayout;
    const repoLayout = join(dir, 'agent', 'src', 'assets', BRAND_LOGO_FILENAME);
    if (existsSync(repoLayout)) return repoLayout;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const cwd = process.cwd();
  console.warn(
    `[compositor] brand logo not found. CWD=${cwd}. Walked up ${MAX_WALK_UP} levels looking for src/assets/${BRAND_LOGO_FILENAME} and agent/src/assets/${BRAND_LOGO_FILENAME}.`,
  );
  throw new Error(
    'Rafiqspace brand logo not found. Expected agent/src/assets/image.png (or src/assets/image.png when CWD is the agent workspace).',
  );
}

export function loadBrandLogoBytes(pathOverride?: string): Uint8Array {
  if (pathOverride) return readFileSync(pathOverride);
  if (cachedLogoBytes) return cachedLogoBytes;
  const path = resolveBrandLogoPath();
  cachedLogoBytes = readFileSync(path);
  return cachedLogoBytes;
}

export function __resetBrandLogoCacheForTests(): void {
  cachedLogoBytes = undefined;
}

let fontsRegistered = false;
function ensureFontsRegistered(): void {
  if (fontsRegistered) return;
  fontsRegistered = true;
}

interface LayoutRegions {
  safeMargin: number;
  topZone: ZoneBox;
  middleZone: ZoneBox;
  bottomZone: ZoneBox;
}

interface ZoneBox { x: number; y: number; w: number; h: number; }

function buildLayout(canvasW: number, canvasH: number, pillar: ContentPillar, hasHeroNumber: boolean): LayoutRegions {
  const defaults = COMPOSITION_PLAN_DEFAULTS[pillar];
  const safeMargin = Math.round(canvasW * defaults.safeMarginRatio);
  const topRatio = hasHeroNumber ? defaults.topZoneRatioWithHero : defaults.topZoneRatioWithoutHero;
  const bottomRatio = defaults.bottomZoneRatio;
  const topH = Math.round(canvasH * topRatio);
  const bottomH = Math.round(canvasH * bottomRatio);
  const middleH = canvasH - topH - bottomH;
  return {
    safeMargin,
    topZone: { x: 0, y: 0, w: canvasW, h: topH },
    middleZone: { x: 0, y: topH, w: canvasW, h: middleH },
    bottomZone: { x: 0, y: topH + middleH, w: canvasW, h: bottomH },
  };
}

function buildPlan(canvasW: number, canvasH: number, pillar: ContentPillar, hasHeroNumber: boolean): CompositionPlan {
  const defaults = COMPOSITION_PLAN_DEFAULTS[pillar];
  const layout = buildLayout(canvasW, canvasH, pillar, hasHeroNumber);
  return {
    width: canvasW, height: canvasH,
    safeMargin: layout.safeMargin,
    topZoneHeight: layout.topZone.h,
    bottomZoneHeight: layout.bottomZone.h,
    frameColor: defaults.frameColor,
    middleBgColor: defaults.middleBgColor,
    textColor: defaults.textColor,
    mutedTextColor: defaults.mutedTextColor,
    accentColor: defaults.accentColor,
    logoSize: Math.round(canvasW * defaults.logoSizeRatio),
  };
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  if (hex.startsWith('#') && hex.length === 7) {
    return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
  }
  return { r: 10, g: 22, b: 40 };
}

function isDarkPillar(pillar: ContentPillar): boolean {
  return pillar === 'TECHNOLOGY' || pillar === 'GENERAL';
}

export async function composeVisual({
  brief, backgroundBytes, logoBytes, canvasSize = 1024,
}: {
  brief: VisualBrief; backgroundBytes: Uint8Array; logoBytes: Uint8Array; canvasSize?: number;
}): Promise<Uint8Array> {
  ensureFontsRegistered();
  const plan = buildPlan(canvasSize, canvasSize, brief.contentPillar, Boolean(brief.heroNumber));
  const layout = buildLayout(canvasSize, canvasSize, brief.contentPillar, Boolean(brief.heroNumber));
  const { r, g, b } = parseHex(plan.frameColor);
  const dark = isDarkPillar(brief.contentPillar);
  const canvas = createCanvas(plan.width, plan.height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // 1. Background (Cover without stretching)
  const bgImage = await loadImage(Buffer.from(backgroundBytes));
  // Pixel-dimension guard: the bytes are provider-trusted, but a small-but-
  // dense image declaring huge dimensions would make @napi-rs/canvas attempt
  // a giant allocation. Bound the decode result before any drawing math.
  const MAX_BACKGROUND_PIXELS = 40_000_000; // e.g. ~6300×6300
  if (bgImage.width * bgImage.height > MAX_BACKGROUND_PIXELS) {
    throw new Error('Background image dimensions exceed the compositor limit.');
  }
  const scale = Math.max(plan.width / bgImage.width, plan.height / bgImage.height);
  const drawW = bgImage.width * scale;
  const drawH = bgImage.height * scale;
  const drawX = (plan.width - drawW) / 2;
  const drawY = (plan.height - drawH) / 2;
  ctx.drawImage(bgImage as Image, drawX, drawY, drawW, drawH);

  // 2. Overlay gradients (Left side + Bottom for facts)
  const leftGrd = ctx.createLinearGradient(0, 0, plan.width * 0.75, 0);
  leftGrd.addColorStop(0, `rgba(${r},${g},${b},${dark ? 0.95 : 0.85})`);
  leftGrd.addColorStop(0.5, `rgba(${r},${g},${b},${dark ? 0.82 : 0.65})`);
  leftGrd.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = leftGrd;
  ctx.fillRect(0, 0, plan.width, plan.height);
  
  const bottomGrd = ctx.createLinearGradient(0, plan.height, 0, plan.height * 0.75);
  bottomGrd.addColorStop(0, `rgba(${r},${g},${b},${dark ? 0.95 : 0.85})`);
  bottomGrd.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = bottomGrd;
  ctx.fillRect(0, 0, plan.width, plan.height);

  const logoImage = await loadImage(Buffer.from(logoBytes));
  const m = plan.safeMargin;
  let cursorY = m;

  // 3. Top bar: logo + brand name + tagline
  cursorY = await drawTopBar(ctx, plan, logoImage, m, cursorY, dark);
  cursorY += Math.round(plan.width * 0.025);

  // Accent divider under top bar
  drawAccentRule(ctx, plan, m, cursorY, plan.width * 0.55);
  cursorY += Math.round(plan.width * 0.018);

  // 4. Category tag (only for NEWS)
  if (brief.contentPillar !== 'CELEBRATION') {
    cursorY = drawCategoryTag(ctx, plan, brief.contentPillar, m, cursorY);
    cursorY += Math.round(plan.width * 0.03);
  }

  // 5, 6, 7. Hero Number, Headline, Context
  if (brief.contentPillar === 'CELEBRATION') {
    // Headline first (e.g. "Selamat...")
    cursorY = drawCelebrationHeadline(ctx, plan, brief.headline, m, cursorY, plan.width * 0.58);
    cursorY += Math.round(plan.width * 0.02);
    
    // Subheadline (heroNumber, e.g. "HUT ke-499")
    if (brief.heroNumber && brief.heroNumber.trim().length > 0) {
      cursorY = drawCelebrationSubheadline(ctx, plan, brief.heroNumber, m, cursorY);
      cursorY += Math.round(plan.width * 0.02);
    }
    
    // Date badge
    if (brief.date && brief.date.trim().length > 0) {
      cursorY = drawDateBadge(ctx, plan, brief.date, m, cursorY);
      cursorY += Math.round(plan.width * 0.03);
    }

    // Context / Thesis
    if (brief.context) {
      cursorY = drawCelebrationContext(ctx, plan, brief.context, m, cursorY, plan.width * 0.58);
      cursorY += Math.round(plan.width * 0.02);
    }
  } else {
    if (brief.heroNumber && brief.heroNumber.trim().length > 0) {
      cursorY = drawHeroNumber(ctx, plan, brief.heroNumber, m, cursorY, plan.width * 0.58);
      cursorY += Math.round(plan.width * 0.01);
    }

    cursorY = drawHeadline(ctx, plan, brief.headline, m, cursorY, plan.width * 0.58);
    cursorY += Math.round(plan.width * 0.018);

    if (brief.context) {
      cursorY = drawBodyText(ctx, plan, brief.context, m, cursorY, plan.width * 0.58);
      cursorY += Math.round(plan.width * 0.02);
    }
  }

  const footerH = Math.round(plan.height * 0.08);

  // 8. Editorial Facts (3-Column Grid)
  if (brief.facts && brief.facts.length > 0) {
    const factsHeight = Math.round(plan.height * 0.16);
    const factsTop = plan.height - footerH - factsHeight - Math.round(plan.height * 0.01);
    drawFactsGrid(ctx, plan, brief.facts, m, factsTop, plan.width - m * 2, factsHeight, dark);
  }


  // Accent rule above footer
  const ruleY = plan.height - footerH - Math.round(plan.height * 0.01);
  drawAccentRule(ctx, plan, m, ruleY, plan.width - m * 2);

  // 9. Footer
  const footerY = plan.height - footerH;
  if (brief.contentPillar === 'CELEBRATION') {
    drawCelebrationFooter(ctx, plan, m, footerY, footerH, logoImage);
  } else {
    drawTechFooter(ctx, plan, brief.source, m, footerY, footerH, logoImage, brief.logoPosition);
  }

  return canvas.toBuffer('image/png');
}

// ── Primitives ────────────────────────────────────────────────────────────────

function drawRoundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawAccentRule(ctx: SKRSContext2D, plan: CompositionPlan, x: number, y: number, width: number): void {
  ctx.save();
  const ruleGrd = ctx.createLinearGradient(x, y, x + width, y);
  ruleGrd.addColorStop(0, plan.accentColor);
  ruleGrd.addColorStop(0.6, plan.accentColor);
  ruleGrd.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.strokeStyle = ruleGrd;
  ctx.lineWidth = Math.round(plan.width * 0.003);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + width, y);
  ctx.stroke();
  ctx.restore();
}

async function drawTopBar(
  ctx: SKRSContext2D, plan: CompositionPlan, logoImage: Image,
  x: number, y: number, dark: boolean,
): Promise<number> {
  const logoSize = Math.round(plan.width * 0.115);
  const aspect = logoImage.width / logoImage.height;
  const drawW = aspect >= 1 ? logoSize : Math.round(logoSize * aspect);
  const drawH = aspect >= 1 ? Math.round(logoSize / aspect) : logoSize;
  ctx.drawImage(logoImage as Image, x, y, drawW, drawH);
  const textX = x + drawW + Math.round(plan.width * 0.022);
  const brandSize = Math.round(plan.width * 0.038);
  const taglineSize = Math.round(plan.width * 0.022);
  ctx.save();
  ctx.textBaseline = 'top';
  ctx.font = `bold ${brandSize}px sans-serif`;
  ctx.fillStyle = dark ? '#ffffff' : plan.frameColor;
  ctx.fillText('RAFIQSPACE AI', textX, y + Math.round(drawH * 0.15));
  ctx.font = `${taglineSize}px sans-serif`;
  ctx.fillStyle = plan.mutedTextColor;
  ctx.fillText('Your Gentle AI Companion', textX, y + Math.round(drawH * 0.15) + brandSize + 6);
  ctx.restore();
  return y + Math.max(drawH, brandSize + taglineSize + 12);
}

function drawCategoryTag(
  ctx: SKRSContext2D, plan: CompositionPlan, pillar: ContentPillar, x: number, y: number,
): number {
  const label = pillar === 'CELEBRATION' ? 'SPECIAL MOMENT' : `${pillar} NEWS`;
  const fontSize = Math.round(plan.width * 0.022);
  ctx.save();
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.fillStyle = plan.accentColor;
  ctx.textBaseline = 'top';
  ctx.fillText(label, x, y);
  const labelW = ctx.measureText(label).width;
  const ruleStartX = x + labelW + Math.round(plan.width * 0.015);
  const ruleEndX = x + plan.width * 0.5;
  ctx.strokeStyle = plan.accentColor;
  ctx.lineWidth = Math.round(plan.width * 0.003);
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(ruleStartX, y + fontSize / 2 + 2);
  ctx.lineTo(ruleEndX, y + fontSize / 2 + 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
  return y + fontSize;
}

function drawHeroNumber(
  ctx: SKRSContext2D, plan: CompositionPlan, heroNumber: string,
  x: number, y: number, maxWidth: number,
): number {
  const baseSize = Math.round(plan.width * 0.105);
  const fontSize = fitFontSize(ctx, heroNumber, maxWidth, baseSize, Math.round(baseSize * 0.55));
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 15;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = plan.accentColor;
  ctx.textBaseline = 'top';
  ctx.fillText(heroNumber, x, y);
  ctx.restore();
  return y + Math.round(fontSize * 1.02);
}

function drawHeadline(
  ctx: SKRSContext2D, plan: CompositionPlan, headline: string,
  x: number, y: number, maxWidth: number,
): number {
  const fontSize = Math.round(plan.width * 0.075);
  const lineHeight = Math.round(fontSize * 1.12);
  const maxLines = 4;
  ctx.font = `900 ${fontSize}px sans-serif`;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = plan.textColor;
  ctx.textBaseline = 'top';
  wrapText(ctx, headline, x, y, maxWidth, lineHeight, maxLines);
  ctx.restore();
  const renderedLines = Math.min(maxLines, countWrappedLines(ctx, headline, maxWidth));
  return y + renderedLines * lineHeight;
}

function drawBodyText(
  ctx: SKRSContext2D, plan: CompositionPlan, text: string,
  x: number, y: number, maxWidth: number,
): number {
  const fontSize = Math.round(plan.width * 0.032);
  const lineHeight = Math.round(fontSize * 1.55);
  const maxLines = 3;
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = plan.textColor;
  ctx.textBaseline = 'top';
  ctx.globalAlpha = 0.88;
  wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines);
  ctx.globalAlpha = 1;
  const renderedLines = Math.min(maxLines, countWrappedLines(ctx, text, maxWidth));
  return y + renderedLines * lineHeight;
}

function drawCelebrationHeadline(ctx: SKRSContext2D, plan: CompositionPlan, text: string, x: number, y: number, maxWidth: number): number {
  const fontSize = Math.round(plan.width * 0.08);
  const lineHeight = Math.round(fontSize * 1.1);
  const maxLines = 4;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.fillStyle = plan.textColor;
  ctx.textBaseline = 'top';
  wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines);
  const renderedLines = Math.min(maxLines, countWrappedLines(ctx, text, maxWidth));
  return y + renderedLines * lineHeight;
}

function drawCelebrationSubheadline(ctx: SKRSContext2D, plan: CompositionPlan, text: string, x: number, y: number): number {
  const fontSize = Math.round(plan.width * 0.05);
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.fillStyle = plan.textColor;
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y);
  return y + fontSize * 1.2;
}

function drawDateBadge(ctx: SKRSContext2D, plan: CompositionPlan, dateText: string, x: number, y: number): number {
  const fontSize = Math.round(plan.width * 0.025);
  ctx.font = `bold ${fontSize}px sans-serif`;
  const textW = ctx.measureText(dateText).width;
  const padX = Math.round(plan.width * 0.025);
  const padY = Math.round(plan.width * 0.015);
  
  const iconSize = Math.round(fontSize * 1.2);
  const gap = Math.round(plan.width * 0.01);
  const totalW = padX * 2 + iconSize + gap + textW;
  const totalH = padY * 2 + fontSize;
  const radius = Math.round(totalH / 2);

  ctx.save();
  // Pill background
  ctx.fillStyle = plan.frameColor;
  ctx.strokeStyle = plan.accentColor;
  ctx.lineWidth = Math.round(plan.width * 0.002);
  drawRoundRect(ctx, x, y, totalW, totalH, radius);
  ctx.fill();
  ctx.stroke();

  // Calendar Icon
  const iconX = x + padX;
  const iconY = y + totalH/2 - iconSize/2;
  ctx.strokeStyle = plan.accentColor;
  ctx.lineWidth = Math.round(iconSize * 0.1);
  ctx.beginPath();
  ctx.rect(iconX, iconY + iconSize*0.2, iconSize, iconSize*0.8);
  ctx.moveTo(iconX, iconY + iconSize*0.5);
  ctx.lineTo(iconX + iconSize, iconY + iconSize*0.5);
  ctx.moveTo(iconX + iconSize*0.3, iconY);
  ctx.lineTo(iconX + iconSize*0.3, iconY + iconSize*0.4);
  ctx.moveTo(iconX + iconSize*0.7, iconY);
  ctx.lineTo(iconX + iconSize*0.7, iconY + iconSize*0.4);
  ctx.stroke();

  // Text
  ctx.fillStyle = plan.accentColor;
  ctx.textBaseline = 'middle';
  ctx.fillText(dateText, iconX + iconSize + gap, y + totalH/2);

  ctx.restore();
  return y + totalH;
}

function drawCelebrationContext(ctx: SKRSContext2D, plan: CompositionPlan, text: string, x: number, y: number, maxWidth: number): number {
  const fontSize = Math.round(plan.width * 0.032);
  const lineHeight = Math.round(fontSize * 1.55);
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = plan.textColor;
  ctx.textBaseline = 'top';
  ctx.globalAlpha = 0.88;
  const maxLines = 3;
  wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines);
  ctx.globalAlpha = 1;
  const renderedLines = Math.min(maxLines, countWrappedLines(ctx, text, maxWidth));
  return y + renderedLines * lineHeight;
}



function drawMinimalIcon(ctx: SKRSContext2D, cx: number, cy: number, size: number, color: string, iconType: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.5, size * 0.1);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  const s = size * 0.45; // half size
  
  switch (iconType) {
    case 'shield':
      ctx.beginPath();
      ctx.moveTo(cx, cy - s*0.8);
      ctx.lineTo(cx + s*0.75, cy - s*0.5);
      ctx.lineTo(cx + s*0.75, cy + s*0.1);
      ctx.bezierCurveTo(cx + s*0.75, cy + s*0.6, cx + s*0.3, cy + s*0.9, cx, cy + s*1.0);
      ctx.bezierCurveTo(cx - s*0.3, cy + s*0.9, cx - s*0.75, cy + s*0.6, cx - s*0.75, cy + s*0.1);
      ctx.lineTo(cx - s*0.75, cy - s*0.5);
      ctx.closePath();
      ctx.stroke();
      
      // inner check
      ctx.beginPath();
      ctx.moveTo(cx - s*0.3, cy + s*0.1);
      ctx.lineTo(cx - s*0.05, cy + s*0.35);
      ctx.lineTo(cx + s*0.4, cy - s*0.2);
      ctx.stroke();
      break;
      
    case 'network':
      ctx.beginPath(); ctx.arc(cx, cy, s*0.4, 0, Math.PI * 2); ctx.stroke();
      
      ctx.beginPath(); ctx.arc(cx - s*0.7, cy + s*0.6, s*0.2, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + s*0.7, cy + s*0.6, s*0.2, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy - s*0.7, s*0.2, 0, Math.PI*2); ctx.fill();
      
      ctx.beginPath();
      ctx.moveTo(cx - s*0.6, cy + s*0.4); ctx.lineTo(cx - s*0.3, cy + s*0.2);
      ctx.moveTo(cx + s*0.6, cy + s*0.4); ctx.lineTo(cx + s*0.3, cy + s*0.2);
      ctx.moveTo(cx, cy - s*0.5); ctx.lineTo(cx, cy - s*0.3);
      ctx.stroke();
      break;
      
    case 'people':
      // center person
      ctx.beginPath(); ctx.arc(cx, cy - s*0.4, s*0.3, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - s*0.5, cy + s*0.6); ctx.quadraticCurveTo(cx, cy - s*0.1, cx + s*0.5, cy + s*0.6); ctx.stroke();
      // left person
      ctx.lineWidth = Math.max(1.5, size * 0.08);
      ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.arc(cx - s*0.6, cy - s*0.1, s*0.2, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - s*0.9, cy + s*0.7); ctx.quadraticCurveTo(cx - s*0.6, cy + s*0.2, cx - s*0.3, cy + s*0.7); ctx.stroke();
      // right person
      ctx.beginPath(); ctx.arc(cx + s*0.6, cy - s*0.1, s*0.2, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + s*0.9, cy + s*0.7); ctx.quadraticCurveTo(cx + s*0.6, cy + s*0.2, cx + s*0.3, cy + s*0.7); ctx.stroke();
      ctx.globalAlpha = 1;
      break;
      
    case 'bulb':
      ctx.beginPath();
      ctx.arc(cx, cy - s*0.3, s*0.5, Math.PI * 0.75, Math.PI * 2.25);
      ctx.lineTo(cx + s*0.25, cy + s*0.4);
      ctx.lineTo(cx - s*0.25, cy + s*0.4);
      ctx.closePath();
      ctx.stroke();
      
      ctx.beginPath();
      ctx.moveTo(cx - s*0.2, cy + s*0.6); ctx.lineTo(cx + s*0.2, cy + s*0.6);
      ctx.moveTo(cx - s*0.1, cy + s*0.8); ctx.lineTo(cx + s*0.1, cy + s*0.8);
      ctx.stroke();
      
      ctx.beginPath();
      ctx.moveTo(cx, cy - s*0.1); ctx.lineTo(cx, cy + s*0.2);
      ctx.stroke();
      break;
      
    case 'chart':
      // axes
      ctx.beginPath();
      ctx.moveTo(cx - s*0.7, cy + s*0.7); ctx.lineTo(cx + s*0.7, cy + s*0.7);
      ctx.moveTo(cx - s*0.7, cy + s*0.7); ctx.lineTo(cx - s*0.7, cy - s*0.7);
      ctx.stroke();
      // bars
      ctx.fillRect(cx - s*0.4, cy + s*0.2, s*0.25, s*0.5);
      ctx.fillRect(cx + s*0.0, cy - s*0.2, s*0.25, s*0.9);
      ctx.fillRect(cx + s*0.4, cy - s*0.6, s*0.25, s*1.3);
      // arrow trend
      ctx.beginPath();
      ctx.moveTo(cx - s*0.3, cy + s*0.1);
      ctx.lineTo(cx + s*0.1, cy - s*0.4);
      ctx.lineTo(cx + s*0.5, cy - s*0.8);
      ctx.lineTo(cx + s*0.5, cy - s*0.5);
      ctx.moveTo(cx + s*0.5, cy - s*0.8);
      ctx.lineTo(cx + s*0.2, cy - s*0.8);
      ctx.stroke();
      break;

    case 'rocket':
      ctx.beginPath();
      ctx.moveTo(cx - s*0.6, cy + s*0.6);
      ctx.lineTo(cx - s*0.3, cy + s*0.3);
      ctx.stroke();
      
      ctx.beginPath();
      ctx.moveTo(cx - s*0.4, cy + s*0.4);
      ctx.bezierCurveTo(cx - s*0.6, cy + s*0.1, cx - s*0.6, cy - s*0.8, cx + s*0.7, cy - s*0.8);
      ctx.bezierCurveTo(cx + s*0.7, cy - s*0.8, cx + s*0.1, cy - s*0.6, cx - s*0.2, cy + s*0.2);
      ctx.closePath();
      ctx.stroke();
      
      ctx.beginPath();
      ctx.arc(cx + s*0.1, cy - s*0.2, s*0.15, 0, Math.PI*2);
      ctx.stroke();
      
      ctx.beginPath();
      ctx.moveTo(cx - s*0.4, cy + s*0.1); ctx.lineTo(cx - s*0.7, cy + s*0.2); ctx.lineTo(cx - s*0.5, cy - s*0.2);
      ctx.moveTo(cx + s*0.1, cy + s*0.4); ctx.lineTo(cx + s*0.2, cy + s*0.7); ctx.lineTo(cx - s*0.2, cy + s*0.5);
      ctx.stroke();
      break;

    case 'target':
      ctx.beginPath(); ctx.arc(cx, cy, s*0.7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, s*0.3, 0, Math.PI * 2); ctx.fill();
      
      ctx.beginPath();
      ctx.moveTo(cx + s*0.2, cy - s*0.2); ctx.lineTo(cx + s*0.8, cy - s*0.8);
      ctx.moveTo(cx + s*0.8, cy - s*0.8); ctx.lineTo(cx + s*0.4, cy - s*0.8);
      ctx.moveTo(cx + s*0.8, cy - s*0.8); ctx.lineTo(cx + s*0.8, cy - s*0.4);
      ctx.stroke();
      break;
      
    case 'globe':
      ctx.beginPath(); ctx.arc(cx, cy, s*0.7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(cx, cy, s*0.3, s*0.7, 0, 0, Math.PI*2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - s*0.7, cy); ctx.lineTo(cx + s*0.7, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - s*0.5, cy - s*0.4); ctx.lineTo(cx + s*0.5, cy - s*0.4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - s*0.5, cy + s*0.4); ctx.lineTo(cx + s*0.5, cy + s*0.4); ctx.stroke();
      break;
      
    case 'chip':
      ctx.beginPath(); ctx.rect(cx - s*0.5, cy - s*0.5, s*1.0, s*1.0); ctx.stroke();
      ctx.beginPath(); ctx.rect(cx - s*0.2, cy - s*0.2, s*0.4, s*0.4); ctx.stroke();
      // pins top
      ctx.beginPath(); ctx.moveTo(cx - s*0.3, cy - s*0.5); ctx.lineTo(cx - s*0.3, cy - s*0.7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - s*0.5); ctx.lineTo(cx, cy - s*0.7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + s*0.3, cy - s*0.5); ctx.lineTo(cx + s*0.3, cy - s*0.7); ctx.stroke();
      // pins bottom
      ctx.beginPath(); ctx.moveTo(cx - s*0.3, cy + s*0.5); ctx.lineTo(cx - s*0.3, cy + s*0.7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy + s*0.5); ctx.lineTo(cx, cy + s*0.7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + s*0.3, cy + s*0.5); ctx.lineTo(cx + s*0.3, cy + s*0.7); ctx.stroke();
      // pins left
      ctx.beginPath(); ctx.moveTo(cx - s*0.5, cy - s*0.3); ctx.lineTo(cx - s*0.7, cy - s*0.3); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - s*0.5, cy); ctx.lineTo(cx - s*0.7, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - s*0.5, cy + s*0.3); ctx.lineTo(cx - s*0.7, cy + s*0.3); ctx.stroke();
      // pins right
      ctx.beginPath(); ctx.moveTo(cx + s*0.5, cy - s*0.3); ctx.lineTo(cx + s*0.7, cy - s*0.3); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + s*0.5, cy); ctx.lineTo(cx + s*0.7, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + s*0.5, cy + s*0.3); ctx.lineTo(cx + s*0.7, cy + s*0.3); ctx.stroke();
      break;

    case 'heart':
      ctx.beginPath();
      ctx.moveTo(cx, cy + s*0.6);
      ctx.bezierCurveTo(cx, cy + s*0.6, cx - s*0.8, cy + s*0.1, cx - s*0.8, cy - s*0.3);
      ctx.arc(cx - s*0.4, cy - s*0.3, s*0.4, Math.PI, 0);
      ctx.arc(cx + s*0.4, cy - s*0.3, s*0.4, Math.PI, 0);
      ctx.bezierCurveTo(cx + s*0.8, cy + s*0.1, cx, cy + s*0.6, cx, cy + s*0.6);
      ctx.stroke();
      break;

    case 'star':
      ctx.beginPath();
      ctx.moveTo(cx, cy - s*0.8);
      ctx.lineTo(cx + s*0.25, cy - s*0.25);
      ctx.lineTo(cx + s*0.8, cy - s*0.25);
      ctx.lineTo(cx + s*0.35, cy + s*0.15);
      ctx.lineTo(cx + s*0.5, cy + s*0.8);
      ctx.lineTo(cx, cy + s*0.45);
      ctx.lineTo(cx - s*0.5, cy + s*0.8);
      ctx.lineTo(cx - s*0.35, cy + s*0.15);
      ctx.lineTo(cx - s*0.8, cy - s*0.25);
      ctx.lineTo(cx - s*0.25, cy - s*0.25);
      ctx.closePath();
      ctx.stroke();
      break;
      
    case 'building':
      ctx.beginPath(); ctx.rect(cx - s*0.6, cy + s*0.7, s*1.2, -s*1.2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - s*0.2, cy - s*0.5); ctx.lineTo(cx - s*0.2, cy - s*1.0); ctx.lineTo(cx + s*0.6, cy - s*1.0); ctx.lineTo(cx + s*0.6, cy - s*0.5); ctx.stroke();
      // windows
      ctx.fillRect(cx - s*0.4, cy - s*0.3, s*0.2, s*0.2);
      ctx.fillRect(cx - s*0.4, cy + s*0.1, s*0.2, s*0.2);
      ctx.fillRect(cx + s*0.2, cy - s*0.3, s*0.2, s*0.2);
      ctx.fillRect(cx + s*0.2, cy + s*0.1, s*0.2, s*0.2);
      // door
      ctx.beginPath(); ctx.rect(cx - s*0.15, cy + s*0.7, s*0.3, -s*0.3); ctx.stroke();
      break;

    case 'document':
    default:
      ctx.beginPath(); ctx.rect(cx - s*0.6, cy - s*0.8, s*1.2, s*1.6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - s*0.3, cy - s*0.4); ctx.lineTo(cx + s*0.3, cy - s*0.4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - s*0.3, cy); ctx.lineTo(cx + s*0.3, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - s*0.3, cy + s*0.4); ctx.lineTo(cx, cy + s*0.4); ctx.stroke();
      break;
  }
  ctx.restore();
}

function determineIconType(title: string, fallbackIndex: number): string {
  const t = title.toLowerCase();
  if (t.match(/inovasi|ide|kreatif|cerdas|solusi|pintar/)) return 'bulb';
  if (t.match(/kolaborasi|masyarakat|human|inklusi|sosial|bersama|tim|mitra|orang/)) return 'people';
  if (t.match(/kedaulatan|aman|privasi|perlindungan|mandiri|siber|cyber|sekuriti|lindung/)) return 'shield';
  if (t.match(/teknologi|ai|digital|jaringan|sistem|data|koneksi|internet|komputer/)) return 'network';
  if (t.match(/tumbuh|ekonomi|kapasitas|skala|manfaat|fasilitas|bisnis|pasar|profit|investasi|uang/)) return 'chart';
  if (t.match(/cepat|akselerasi|luncur|startup|baru|roket|dorong|pacu/)) return 'rocket';
  if (t.match(/target|tujuan|fokus|sasaran|misi|visi|goal|presisi/)) return 'target';
  if (t.match(/global|dunia|internasional|bumi|negara|wilayah|daerah/)) return 'globe';
  if (t.match(/chip|prosesor|hardware|gpu|cpu|infrastruktur|server|komputasi/)) return 'chip';
  if (t.match(/peduli|kesehatan|cinta|hati|hidup|medis|sehat/)) return 'heart';
  if (t.match(/unggulan|terbaik|juara|prestasi|bintang|utama|rating|kualitas/)) return 'star';
  if (t.match(/bangun|gedung|kantor|pabrik|pusat|kampus|sekolah/)) return 'building';
  
  const fallbacks = ['document', 'network', 'shield', 'bulb', 'chart', 'people', 'rocket', 'target', 'globe', 'chip'];
  return fallbacks[fallbackIndex % fallbacks.length];
}

function drawFactsGrid(
  ctx: SKRSContext2D, plan: CompositionPlan, facts: readonly string[],
  x: number, y: number, totalWidth: number, height: number, dark: boolean,
): void {
  const factCount = facts.length;
  const columnWidth = Math.round(totalWidth / factCount);
  const titleSize = Math.round(plan.width * 0.024);
  const bodySize = Math.round(plan.width * 0.02);
  const bodyLineHeight = Math.round(bodySize * 1.45);
  const iconSize = Math.round(plan.width * 0.032);

  facts.forEach((fact, index) => {
    const colX = x + columnWidth * index;
    
    // Draw vertical divider (except for first column)
    if (index > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(colX, y + Math.round(height * 0.1));
      ctx.lineTo(colX, y + Math.round(height * 0.7));
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }

    const padX = Math.round(columnWidth * 0.12);
    const textMaxWidth = columnWidth - padX * 2;
    const contentX = colX + padX;
    
    let title = '';
    let body = fact;
    if (fact.includes(':')) {
      const ci = fact.indexOf(':');
      title = fact.slice(0, ci).trim();
      body = fact.slice(ci + 1).trim();
    }

    let currentY = y;
    
    // Icon
    const iconCx = contentX + iconSize / 2;
    const iconCy = currentY + iconSize / 2;
    const iconType = determineIconType(title, index);
    drawMinimalIcon(ctx, iconCx, iconCy, iconSize, plan.accentColor, iconType);
    currentY += iconSize + Math.round(plan.width * 0.015);

    // Title
    if (title) {
      ctx.save();
      ctx.font = `bold ${titleSize}px sans-serif`;
      ctx.fillStyle = plan.textColor;
      ctx.textBaseline = 'top';
      ctx.fillText(title, contentX, currentY);
      currentY += Math.round(titleSize * 1.4);
      ctx.restore();
    }

    // Body
    ctx.save();
    ctx.font = `${bodySize}px sans-serif`;
    ctx.fillStyle = plan.textColor;
    ctx.textBaseline = 'top';
    wrapText(ctx, body, contentX, currentY, textMaxWidth, bodyLineHeight, 3);
    ctx.restore();
  });
}

function drawTechFooter(
  ctx: SKRSContext2D, plan: CompositionPlan, source: string,
  x: number, footerY: number, footerH: number, logoImage: Image,
  logoPosition: LogoPosition = 'bottom-right',
): void {
  const midY = footerY + footerH / 2;
  const fontSize = Math.round(plan.width * 0.019);
  ctx.save();
  ctx.textBaseline = 'middle';

  // Just minimal source attribution on the left (no duplicated logo)
  if (source && source.trim().length > 0) {
    // Subtle line indicator
    ctx.beginPath();
    ctx.moveTo(x, midY - Math.round(fontSize * 0.6));
    ctx.lineTo(x, midY + Math.round(fontSize * 0.6));
    ctx.strokeStyle = plan.accentColor;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.font = `${fontSize}px sans-serif`;
    ctx.fillStyle = plan.mutedTextColor;
    ctx.fillText(source, x + Math.round(plan.width * 0.015), midY);
  }

  ctx.restore();
}

function drawCelebrationFooter(
  ctx: SKRSContext2D, plan: CompositionPlan,
  x: number, footerY: number, footerH: number, logoImage: Image,
): void {
  const lineH = footerH / 2;
  const fontSize = Math.round(plan.width * 0.022);
  ctx.save();

  // Subtle line indicator
  ctx.beginPath();
  ctx.moveTo(x, footerY + Math.round(footerH * 0.15));
  ctx.lineTo(x, footerY + Math.round(footerH * 0.85));
  ctx.strokeStyle = plan.accentColor;
  ctx.lineWidth = 3;
  ctx.stroke();

  const textX = x + Math.round(plan.width * 0.015);
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = plan.textColor;
  ctx.textBaseline = 'top';
  ctx.fillText('Hormat kami,', textX, footerY + Math.round(footerH * 0.1));
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.fillStyle = plan.accentColor;
  ctx.fillText('Keluarga Besar PT Rafiq Space Intelligence', textX, footerY + lineH);

  ctx.restore();
}

// ── Typography helpers ────────────────────────────────────────────────────────

function wrapText(
  ctx: SKRSContext2D, text: string,
  x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number,
): void {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return;
  let line = '';
  let lineCount = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i]!;
    const width = ctx.measureText(test).width;
    if (width > maxWidth && line) {
      ctx.fillText(clampToWidth(ctx, line, maxWidth), x, y + lineCount * lineHeight);
      line = words[i]!;
      lineCount += 1;
      if (lineCount >= maxLines - 1) {
        // Final line: collapse the remaining words and HARD-CLAMP to the
        // column width with an ellipsis. Without the clamp, a schema-valid
        // but over-long headline renders ~1600px of text on a 1024px canvas
        // and is silently raster-clipped at the canvas edge.
        const remaining = clampToWidth(ctx, words.slice(i).join(' '), maxWidth);
        ctx.fillText(remaining, x, y + lineCount * lineHeight);
        return;
      }
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(clampToWidth(ctx, line, maxWidth), x, y + lineCount * lineHeight);
}

/**
 * Truncate `text` to fit `maxWidth` at the context's current font, appending a
 * single ellipsis character when truncation occurs. Used by {@link wrapText}
 * so every rendered line — including the final collapsed line of an over-long
 * headline, context, or fact body — stays inside its column.
 */
export function clampToWidth(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  const suffix = '…';
  let clipped = text;
  while (clipped.length > 0 && ctx.measureText(`${clipped}${suffix}`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return clipped ? `${clipped}${suffix}` : suffix;
}

function countWrappedLines(ctx: SKRSContext2D, text: string, maxWidth: number): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  let line = '';
  let lineCount = 1;
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i]!;
    const width = ctx.measureText(test).width;
    if (width > maxWidth && line) {
      line = words[i]!;
      lineCount += 1;
    } else {
      line = test;
    }
  }
  return lineCount;
}

function fitFontSize(
  ctx: SKRSContext2D, text: string, maxWidth: number, startSize: number, minSize: number,
): number {
  let size = startSize;
  while (size > minSize) {
    ctx.font = `bold ${size}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 2;
  }
  return minSize;
}

export type { Canvas, SKRSContext2D, Image };
export { GlobalFonts };
