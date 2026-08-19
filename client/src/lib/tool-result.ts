/**
 * Chat tool-result rendering helpers.
 *
 * Tool results arrive as arbitrary JSON. The chat surfaces a few well-known
 * shapes inline (notably image assets produced by the Visual Content Agent's
 * `generate_image` tool) and falls back to pretty-printed JSON for everything
 * else. These helpers are pure so the shape detection is unit-tested without a
 * React tree.
 */

function imageUrlFromObject(rec: Record<string, unknown>): string | null {
  const direct = rec.imageUrl ?? rec.url ?? rec.image;
  if (typeof direct === 'string' && direct.trim()) return direct;

  const assets = rec.visualAssets;
  if (Array.isArray(assets)) {
    for (const asset of assets) {
      if (asset && typeof asset === 'object') {
        const candidate = (asset as Record<string, unknown>).imageUrl;
        if (typeof candidate === 'string' && candidate.trim()) return candidate;
      }
    }
  }

  return null;
}

/**
 * Resolve an inline-previewable image URL from a tool result, or `null` when
 * the result does not carry one. Recognized shapes:
 * - `{ imageUrl | url | image: string }` (the `generate_image`/`preview_image` tool output)
 * - `{ visualAssets: [{ imageUrl: string }, ...] }` (social-post metadata)
 * - `{ subAgentToolResults: [{ result: { imageUrl | visualAssets } }, ...] }`
 *   (a supervisor delegation tool result that carries the sub-agent's inner
 *   tool output nested — peek into it so the image renders even when only the
 *   delegation tool card is surfaced in the chat).
 */
export function extractImageUrl(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const rec = result as Record<string, unknown>;

  const direct = imageUrlFromObject(rec);
  if (direct) return direct;

  const nested = rec.subAgentToolResults;
  if (Array.isArray(nested)) {
    for (const entry of nested) {
      if (entry && typeof entry === 'object') {
        const entryResult = (entry as Record<string, unknown>).result;
        if (entryResult && typeof entryResult === 'object') {
          const candidate = imageUrlFromObject(entryResult as Record<string, unknown>);
          if (candidate) return candidate;
        }
      }
    }
  }

  return null;
}
