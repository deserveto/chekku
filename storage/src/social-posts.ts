import { randomBytes } from 'node:crypto';

import { createNamespacedObjectStorage } from './namespaced-objects.ts';
import type { ObjectStorage } from './objects.ts';

export const SOCIAL_MEDIA_AGENT_ID = 'social-media-agent';

export type SocialPlatform = 'instagram';

export type SocialPostStatus = 'DRAFT' | 'APPROVED' | 'PUBLISHED';

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

  return {
    postId: metadata.postId,
    createdAt: metadata.createdAt,
    platform: metadata.platform,
    topic: metadata.topic,
    ...(typeof metadata.specialDay === 'string' ? { specialDay: metadata.specialDay } : {}),
    status: metadata.status,
    ...expectedKeys,
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
