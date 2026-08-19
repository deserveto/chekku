import { randomBytes } from 'node:crypto';

import { createNamespacedObjectStorage } from './namespaced-objects.ts';
import { asBinaryObjectStorage, ObjectStorageError, type ObjectStorage } from './objects.ts';

/**
 * Fixed Garage storage namespace for social posts.
 *
 * This is the storage namespace string, decoupled from the agent identity:
 * after the Social Media Supervisor refactor the drafting agent's id is
 * `social-media-content-writer`, but posts continue to live under this
 * historical namespace so existing objects stay readable. The
 * `weekly-social-drafts` workflow pins this value explicitly when writing via
 * the Garage MCP tool; do not change it without migrating existing posts.
 */
export const SOCIAL_MEDIA_AGENT_ID = 'social-media-agent';

export type SocialPlatform = 'instagram';

export type SocialPostStatus = 'DRAFT' | 'APPROVED' | 'PUBLISHED';

/**
 * Allowed output MIME types for a generated visual asset. Stored metadata
 * never contains base64 image data — only this canonical descriptor and the
 * relative object key that locates the binary bytes inside Garage.
 */
export type VisualMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

const VISUAL_MIME_TYPES: readonly VisualMimeType[] = ['image/png', 'image/jpeg', 'image/webp'];

const VISUAL_EXTENSIONS: Record<VisualMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export const VISUAL_ASSET_ID_RE = /^sva_[0-9]{14}_[0-9a-f]{8}$/;

export interface SocialVisualAsset {
  assetId: string;
  objectKey: string;
  imageUrl: string;
  mimeType: VisualMimeType;
  generatedAt: string;
  model: string;
  prompt: string;
  width?: number;
  height?: number;
}

export interface SocialPostMetadata {
  postId: string;
  createdAt: string;
  platform: SocialPlatform;
  topic: string;
  specialDay?: string;
  status: SocialPostStatus;
  postObjectKey: string;
  briefObjectKey: string;
  metadataObjectKey: string;
  visualAssets?: SocialVisualAsset[];
  activeVisualAssetId?: string;
}

/**
 * Pure input for building a social post's canonical metadata. The writer
 * (workflow via MCP, or any future writer) calls `buildSocialPostMetadata`
 * with this shape; nothing here touches storage.
 */
export interface SocialPostMetadataInput {
  postMarkdown: string;
  briefMarkdown: string;
  topic: string;
  platform?: SocialPlatform;
  specialDay?: string;
  status?: SocialPostStatus;
  postId?: string;
  now?: () => Date;
}

export interface BuiltSocialPost {
  metadata: SocialPostMetadata;
  metadataJson: string;
  postObjectKey: string;
  briefObjectKey: string;
  metadataObjectKey: string;
}

export interface SocialPostReadResult {
  postId: string;
  postMarkdown: string;
  briefMarkdown: string;
  metadata: SocialPostMetadata;
}

const POST_ID_RE = /^smp_[0-9]{14}_[0-9a-f]{8}$/;
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

/**
 * Upper bound on a visual-generation prompt stored inside social-post
 * metadata. The {@link generateImageTool} input schema already bounds the
 * incoming prompt to 2,000 UTF-8 bytes; this constant mirrors that limit at
 * the storage/parser boundary so a hostile metadata blob cannot smuggle a
 * huge prompt through the read path.
 */
const MAX_VISUAL_PROMPT_BYTES = 2_000;

const PLATFORMS: readonly SocialPlatform[] = ['instagram'];
const STATUSES: readonly SocialPostStatus[] = ['DRAFT', 'APPROVED', 'PUBLISHED'];

export const createSocialPostStorage = (root: ObjectStorage): ObjectStorage =>
  createNamespacedObjectStorage(root, SOCIAL_MEDIA_AGENT_ID);

export function createPostId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `smp_${stamp}_${randomBytes(4).toString('hex')}`;
}

export function keysFor(postId: string) {
  if (!POST_ID_RE.test(postId)) {
    throw new Error(`Invalid social post id: ${postId}`);
  }
  const base = `social-posts/${postId}`;
  return {
    postObjectKey: `${base}/post.md`,
    briefObjectKey: `${base}/brief.md`,
    metadataObjectKey: `${base}/metadata.json`,
  };
}

export function parseSocialPostTimestamp(value: string): number | undefined {
  const match = RFC3339_RE.exec(value);
  if (!match) return undefined;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', offsetSign, offsetHourText = '0', offsetMinuteText = '0'] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText);
  const offsetMinute = Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12
    || day < 1 || day > daysInMonth[month - 1]!
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) {
    return undefined;
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number(fraction.slice(0, 3).padEnd(3, '0')));
  const offset = (offsetHour * 60 + offsetMinute) * 60_000;
  const timestamp = date.getTime() - (offsetSign === '+' ? offset : offsetSign === '-' ? -offset : 0);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function isSocialPlatform(value: unknown): value is SocialPlatform {
  return value === 'instagram';
}

function isSocialPostStatus(value: unknown): value is SocialPostStatus {
  return STATUSES.includes(value as SocialPostStatus);
}

function isVisualMimeType(value: unknown): value is VisualMimeType {
  return typeof value === 'string' && (VISUAL_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Validate one raw visual asset entry against the post it belongs to. Returns
 * the projected asset when it is internally consistent with `postId`, or
 * `undefined` to drop a malformed/hostile entry without poisoning the whole
 * post. Object keys must match the deterministic layout derived from the
 * (postId, assetId, mimeType) triple, so a hostile metadata blob cannot point
 * the application route at an arbitrary Garage key.
 */
function parseVisualAsset(raw: unknown, postId: string): SocialVisualAsset | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.assetId !== 'string' || !VISUAL_ASSET_ID_RE.test(entry.assetId)) return undefined;
  if (!isVisualMimeType(entry.mimeType)) return undefined;
  if (typeof entry.generatedAt !== 'string' || !RFC3339_RE.test(entry.generatedAt)) return undefined;
  if (typeof entry.model !== 'string' || entry.model.trim().length === 0) return undefined;
  if (typeof entry.prompt !== 'string') return undefined;
  if (Buffer.byteLength(entry.prompt, 'utf8') > MAX_VISUAL_PROMPT_BYTES) return undefined;
  if (entry.width !== undefined && (typeof entry.width !== 'number' || !Number.isFinite(entry.width) || entry.width <= 0)) {
    return undefined;
  }
  if (entry.height !== undefined && (typeof entry.height !== 'number' || !Number.isFinite(entry.height) || entry.height <= 0)) {
    return undefined;
  }

  const expected = visualAssetKeys(postId, entry.assetId, entry.mimeType);
  if (entry.objectKey !== expected.objectKey) return undefined;
  if (entry.imageUrl !== expected.imageUrl) return undefined;

  const asset: SocialVisualAsset = {
    assetId: entry.assetId,
    objectKey: entry.objectKey,
    imageUrl: entry.imageUrl,
    mimeType: entry.mimeType,
    generatedAt: entry.generatedAt,
    model: entry.model,
    prompt: entry.prompt,
    ...(typeof entry.width === 'number' ? { width: entry.width } : {}),
    ...(typeof entry.height === 'number' ? { height: entry.height } : {}),
  };
  return asset;
}

function parseVisualAssets(raw: unknown, postId: string): SocialVisualAsset[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const assets: SocialVisualAsset[] = [];
  for (const entry of raw) {
    const asset = parseVisualAsset(entry, postId);
    if (asset) assets.push(asset);
  }
  return assets;
}

function parseSocialPostMetadata(value: unknown): SocialPostMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const metadata = value as Record<string, unknown>;
  if (typeof metadata.postId !== 'string' || !POST_ID_RE.test(metadata.postId)) return undefined;
  if (typeof metadata.createdAt !== 'string') return undefined;
  if (!isSocialPlatform(metadata.platform)) return undefined;
  if (typeof metadata.topic !== 'string' || metadata.topic.trim().length === 0) return undefined;
  if (metadata.specialDay !== undefined && typeof metadata.specialDay !== 'string') return undefined;
  if (!isSocialPostStatus(metadata.status)) return undefined;

  const expectedKeys = keysFor(metadata.postId);
  if (metadata.postObjectKey !== expectedKeys.postObjectKey
    || metadata.briefObjectKey !== expectedKeys.briefObjectKey
    || metadata.metadataObjectKey !== expectedKeys.metadataObjectKey) {
    return undefined;
  }

  const visualAssets = parseVisualAssets(metadata.visualAssets, metadata.postId);
  let activeVisualAssetId: string | undefined;
  if (metadata.activeVisualAssetId !== undefined) {
    if (typeof metadata.activeVisualAssetId === 'string'
      && visualAssets?.some((asset) => asset.assetId === metadata.activeVisualAssetId)) {
      activeVisualAssetId = metadata.activeVisualAssetId;
    }
  }

  return {
    postId: metadata.postId,
    createdAt: metadata.createdAt,
    platform: metadata.platform,
    topic: metadata.topic,
    ...(typeof metadata.specialDay === 'string' ? { specialDay: metadata.specialDay } : {}),
    status: metadata.status,
    ...expectedKeys,
    ...(visualAssets && visualAssets.length > 0 ? { visualAssets } : {}),
    ...(activeVisualAssetId ? { activeVisualAssetId } : {}),
  };
}

/**
 * Pure builder for a social post's canonical metadata + object keys + JSON
 * serialization. Extracted from the legacy `saveSocialPost` write helper so
 * the workflow can persist via Garage MCP `create_text_object` while keeping
 * the canonical ID, key layout, and metadata schema as a single source of
 * truth shared with the read path.
 *
 * The metadata is computed deterministically from the input; nothing here
 * touches storage. The caller (workflow) is responsible for writing the three
 * objects in `brief → post → metadata` order so partial saves never become
 * list entries.
 *
 * `post.md` content contract (per PROMPT.md action item #3 — Canonical
 * Content Unit, locked D2=c layered + D4=a markdown serialized): the file
 * stores BOTH the canonical content unit and the repurposed platform caption,
 * wrapped via HTML comment delimiters from
 * `agent/src/mastra/social-content/canonical-unit.ts` → `wrapPostMarkdown`:
 *
 *     <!-- canonical-unit -->
 *     <canonical unit markdown — 8 Blocks platform-agnostic intermediate>
 *     <!-- /canonical-unit -->
 *     <!-- repurposed-caption -->
 *     <final platform-specific caption>
 *     <!-- /repurposed-caption -->
 *
 * The metadata schema itself does not change — the canonical unit is just
 * markdown text. Legacy posts written before the canonical contract fall back
 * gracefully: `unwrapPostMarkdown` returns the whole file as
 * `canonicalMarkdown` when no delimiters are present.
 */
export function buildSocialPostMetadata(input: SocialPostMetadataInput): BuiltSocialPost {
  if (typeof input.topic !== 'string' || input.topic.trim().length === 0) {
    throw new Error('Social post topic must not be blank.');
  }
  const platform = input.platform ?? 'instagram';
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`Unsupported social platform: ${String(input.platform)}`);
  }
  const status = input.status ?? 'DRAFT';
  if (!STATUSES.includes(status)) {
    throw new Error(`Unsupported social post status: ${String(input.status)}`);
  }
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const postId = input.postId ?? createPostId(new Date(createdAt));
  const objectKeys = keysFor(postId);
  const metadata: SocialPostMetadata = {
    postId,
    createdAt,
    platform,
    topic: input.topic,
    ...(input.specialDay ? { specialDay: input.specialDay } : {}),
    status,
    ...objectKeys,
  };
  return {
    metadata,
    metadataJson: JSON.stringify(metadata, null, 2),
    ...objectKeys,
  };
}

export async function listSocialPosts(store: ObjectStorage): Promise<SocialPostMetadata[]> {
  const result = await store.listKeys('social-posts/');
  if (result.truncated) {
    throw new Error('Cannot list all social posts: object storage truncated the social-posts/ listing. Increase the storage listing limit.');
  }
  const keys = result.keys.filter((key) => key.endsWith('/metadata.json'));
  const entries = await Promise.all(keys.map(async (key) => {
    const metadataText = await store.getText(key);
    let metadata: unknown;
    try {
      metadata = JSON.parse(metadataText);
    } catch {
      return undefined;
    }
    const parsed = parseSocialPostMetadata(metadata);
    return parsed?.metadataObjectKey === key ? parsed : undefined;
  }));
  const posts = entries.filter((entry): entry is SocialPostMetadata => entry !== undefined);

  return posts
    .map((post, index) => ({ post, index, timestamp: parseSocialPostTimestamp(post.createdAt) }))
    .sort((a, b) => {
      if (a.timestamp === undefined && b.timestamp === undefined) return a.index - b.index;
      if (a.timestamp === undefined) return 1;
      if (b.timestamp === undefined) return -1;
      return b.timestamp - a.timestamp || a.index - b.index;
    })
    .map(({ post }) => post);
}

export async function getSocialPost(store: ObjectStorage, postId: string): Promise<SocialPostReadResult> {
  const objectKeys = keysFor(postId);
  const [postMarkdown, briefMarkdown, metadataText] = await Promise.all([
    store.getText(objectKeys.postObjectKey),
    store.getText(objectKeys.briefObjectKey),
    store.getText(objectKeys.metadataObjectKey),
  ]);

  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    throw new Error(`Invalid social post metadata for ${postId}`);
  }
  const parsed = parseSocialPostMetadata(metadata);
  if (!parsed || parsed.postId !== postId) {
    throw new Error(`Invalid social post metadata for ${postId}`);
  }
  return { postId, postMarkdown, briefMarkdown, metadata: parsed };
}

// ---------------------------------------------------------------------------
// Visual assets
//
// A visual asset is a generated image attached to an APPROVED social post.
// The binary bytes live as a Garage object under the same `social-media-agent`
// namespace as the post; metadata references only the relative object key and
// an application-facing URL (never base64, never credentials, never a private
// S3 URL). Revisions append a new asset and never overwrite the previous one.
// ---------------------------------------------------------------------------

export function createVisualAssetId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `sva_${stamp}_${randomBytes(4).toString('hex')}`;
}

export function extensionForMimeType(mimeType: VisualMimeType): string {
  return VISUAL_EXTENSIONS[mimeType];
}

export function isVisualAssetId(value: string): boolean {
  return VISUAL_ASSET_ID_RE.test(value);
}

export function visualAssetImageUrl(postId: string, assetId: string): string {
  return `/api/storage/social-posts/${postId}/visuals/${assetId}`;
}

/**
 * Deterministic relative object key and application-facing URL for a visual
 * asset. The layout is `social-posts/<postId>/visuals/<assetId>.<ext>` so
 * visuals sit alongside the post they belong to inside the historical
 * `social-media-agent` namespace. Post id and asset id are validated to their
 * canonical forms before any key is produced.
 */
export function visualAssetKeys(
  postId: string,
  assetId: string,
  mimeType: VisualMimeType,
): { objectKey: string; imageUrl: string } {
  if (!POST_ID_RE.test(postId)) {
    throw new Error(`Invalid social post id: ${postId}`);
  }
  if (!VISUAL_ASSET_ID_RE.test(assetId)) {
    throw new Error(`Invalid visual asset id: ${assetId}`);
  }
  if (!isVisualMimeType(mimeType)) {
    throw new Error(`Unsupported visual MIME type: ${String(mimeType)}`);
  }
  const ext = VISUAL_EXTENSIONS[mimeType];
  return {
    objectKey: `social-posts/${postId}/visuals/${assetId}.${ext}`,
    imageUrl: visualAssetImageUrl(postId, assetId),
  };
}

export interface BuildVisualAssetInput {
  postId: string;
  mimeType: VisualMimeType;
  prompt: string;
  model: string;
  assetId?: string;
  generatedAt?: string;
  width?: number;
  height?: number;
  now?: () => Date;
}

export interface BuiltVisualAsset {
  asset: SocialVisualAsset;
  objectKey: string;
  imageUrl: string;
}

/**
 * Pure builder for a {@link SocialVisualAsset} and its deterministic keys.
 * Nothing here touches storage. The caller (the image tool) is responsible
 * for storing the binary bytes at `objectKey` first, then calling
 * {@link attachVisualAsset} to update canonical metadata last.
 */
export function buildVisualAsset(input: BuildVisualAssetInput): BuiltVisualAsset {
  if (typeof input.prompt !== 'string' || Buffer.byteLength(input.prompt, 'utf8') > MAX_VISUAL_PROMPT_BYTES) {
    throw new Error('Visual prompt must be a string of at most 2,000 UTF-8 bytes.');
  }
  if (typeof input.model !== 'string' || input.model.trim().length === 0) {
    throw new Error('Visual model must not be blank.');
  }
  const now = input.now?.() ?? new Date();
  const assetId = input.assetId ?? createVisualAssetId(now);
  const generatedAt = input.generatedAt ?? now.toISOString();
  const keys = visualAssetKeys(input.postId, assetId, input.mimeType);

  const asset: SocialVisualAsset = {
    assetId,
    objectKey: keys.objectKey,
    imageUrl: keys.imageUrl,
    mimeType: input.mimeType,
    generatedAt,
    model: input.model,
    prompt: input.prompt,
    ...(typeof input.width === 'number' && Number.isFinite(input.width) && input.width > 0
      ? { width: Math.floor(input.width) }
      : {}),
    ...(typeof input.height === 'number' && Number.isFinite(input.height) && input.height > 0
      ? { height: Math.floor(input.height) }
      : {}),
  };

  return { asset, objectKey: keys.objectKey, imageUrl: keys.imageUrl };
}

export interface VisualAssetBytes {
  value: Uint8Array;
  contentType: string;
}

/**
 * Per-post in-process serializer for canonical-metadata read-modify-writes.
 * `attachVisualAsset` and `updateSocialPostStatus` both perform a non-atomic
 * `getText` → mutate → `replaceText` over one post's metadata object; without
 * serialization, two concurrent generations for the same post would each read
 * the same snapshot and the second `replaceText` would drop the first asset
 * (orphaning its bytes), breaking the "append preserves prior revisions" rule.
 *
 * This holds across the whole RMW within one server process. Cross-process /
 * external writers remain subject to the documented Garage v2.3 limitation and
 * are not covered by this lock.
 */
const metadataWriteTails = new Map<string, Promise<void>>();

async function serializeMetadataWrite<T>(
  postId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = metadataWriteTails.get(postId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  metadataWriteTails.set(postId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (metadataWriteTails.get(postId) === current) metadataWriteTails.delete(postId);
  }
}

/**
 * Attach a freshly stored visual asset to a social post's canonical metadata.
 *
 * Reads the current metadata, appends the asset (preserving any prior revisions),
 * sets the new asset as active, and writes the updated metadata back via
 * `replaceText` **last**. The caller must have already stored the image bytes
 * at `asset.objectKey` before calling this; a metadata-write failure therefore
 * leaves an orphan byte object that is unreachable through canonical metadata
 * or the application route, never a live entry pointing at missing bytes.
 *
 * The full read-modify-write is serialized per post within the process through
 * {@link serializeMetadataWrite}, so concurrent attachments for one post land
 * in order and never drop a prior revision.
 *
 * Returns the projected metadata after the update.
 */
export async function attachVisualAsset(
  store: ObjectStorage,
  postId: string,
  asset: SocialVisualAsset,
): Promise<SocialPostMetadata> {
  const objectKeys = keysFor(postId);
  if (asset.assetId === '') {
    throw new Error('Visual asset id must not be blank.');
  }
  return serializeMetadataWrite(postId, async () => {
    const metadataText = await store.getText(objectKeys.metadataObjectKey);
    let metadata: unknown;
    try {
      metadata = JSON.parse(metadataText);
    } catch {
      throw new Error(`Invalid social post metadata for ${postId}`);
    }
    const parsed = parseSocialPostMetadata(metadata);
    if (!parsed || parsed.postId !== postId) {
      throw new Error(`Invalid social post metadata for ${postId}`);
    }

    const existing = parsed.visualAssets ?? [];
    if (existing.some((entry) => entry.assetId === asset.assetId)) {
      throw new Error(`Visual asset ${asset.assetId} is already attached to ${postId}.`);
    }
    const updated: SocialPostMetadata = {
      ...parsed,
      visualAssets: [...existing, asset],
      activeVisualAssetId: asset.assetId,
    };
    await store.replaceText(objectKeys.metadataObjectKey, JSON.stringify(updated, null, 2), 'application/json');
    return updated;
  });
}

/**
 * Read the binary bytes of one visual asset for the application-facing image
 * route. Loads the canonical metadata first to verify the `assetId` actually
 * belongs to `postId` (the route never accepts an arbitrary object key from a
 * URL parameter), then reads the bytes through the binary storage capability.
 */
export async function readVisualAssetBytes(
  store: ObjectStorage,
  postId: string,
  assetId: string,
): Promise<VisualAssetBytes> {  const objectKeys = keysFor(postId);
  const metadataText = await store.getText(objectKeys.metadataObjectKey);
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    throw new Error(`Invalid social post metadata for ${postId}`);
  }
  const parsed = parseSocialPostMetadata(metadata);
  if (!parsed || parsed.postId !== postId) {
    throw new Error(`Invalid social post metadata for ${postId}`);
  }
  const asset = (parsed.visualAssets ?? []).find((entry) => entry.assetId === assetId);
  if (!asset) {
    throw new ObjectStorageError('not-found', `Visual asset ${assetId} not found for ${postId}.`);
  }

  const binary = asBinaryObjectStorage(store);
  const result = await binary.getBytes(asset.objectKey);
  return {
    value: result.value,
    contentType: asset.mimeType,
  };
}

/**
 * Allowed social-post status transitions. `DRAFT → APPROVED` is the only
 * transition the approval endpoint exposes; `PUBLISHED` is terminal for this
 * iteration and managed by a future publishing flow, not by this helper.
 */
const ALLOWED_STATUS_TRANSITIONS: Record<SocialPostStatus, readonly SocialPostStatus[]> = {
  DRAFT: ['APPROVED'],
  APPROVED: [],
  PUBLISHED: [],
};

/**
 * Transition a social post's persisted status. Reads the current metadata,
 * validates the transition is allowed, and writes the updated metadata back
 * via `replaceText`. Returns the projected metadata after the update.
 *
 * Only `DRAFT → APPROVED` is permitted. This is the approval mechanism the
 * Visual Content Agent's `generate_image` tool requires: the weekly workflow
 * creates DRAFT posts, the user reviews and approves one through the UI, then
 * asks the supervisor to generate a visual.
 */
export async function updateSocialPostStatus(
  store: ObjectStorage,
  postId: string,
  nextStatus: SocialPostStatus,
): Promise<SocialPostMetadata> {
  const objectKeys = keysFor(postId);
  return serializeMetadataWrite(postId, async () => {
    const metadataText = await store.getText(objectKeys.metadataObjectKey);
    let metadata: unknown;
    try {
      metadata = JSON.parse(metadataText);
    } catch {
      throw new Error(`Invalid social post metadata for ${postId}`);
    }
    const parsed = parseSocialPostMetadata(metadata);
    if (!parsed || parsed.postId !== postId) {
      throw new Error(`Invalid social post metadata for ${postId}`);
    }

    const currentStatus = parsed.status;
    const allowed = ALLOWED_STATUS_TRANSITIONS[currentStatus];
    if (!allowed.includes(nextStatus)) {
      throw new Error(
        `Cannot transition social post ${postId} from ${currentStatus} to ${nextStatus}.`,
      );
    }

    const updated: SocialPostMetadata = { ...parsed, status: nextStatus };
    await store.replaceText(objectKeys.metadataObjectKey, JSON.stringify(updated, null, 2), 'application/json');
    return updated;
  });
}
