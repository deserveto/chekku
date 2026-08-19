/**
 * Image generation provider boundary — public types.
 *
 * The Visual Content Agent never calls a provider HTTP endpoint directly. It
 * goes through an {@link ImageGenerationClient}, which isolates transport,
 * authentication, response validation, and failure normalization behind a
 * single dependency-injectable interface. The tool composes a client instance;
 * tests substitute a stub client.
 *
 * The model id is fixed by server configuration (`LLM_IMAGE_MODEL`) and is
 * never part of {@link ImageGenerationRequest} — a caller cannot select the
 * model, endpoint, or credentials.
 */

export type ImageAspectRatio = '1:1' | '4:5' | '9:16' | '16:9';

export type ImageSize = '1K' | '2K';

/**
 * MIME types the pipeline can persist and serve. The client validates that a
 * provider response resolves to one of these before returning bytes.
 */
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageGenerationRequest {
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  imageSize?: ImageSize;
  mimeType?: ImageMimeType;
}

export interface ImageGenerationResult {
  imageBytes: Uint8Array;
  mimeType: ImageMimeType;
  model: string;
  prompt: string;
  width?: number;
  height?: number;
}

export interface ImageGenerationClient {
  generate(request: ImageGenerationRequest, signal?: AbortSignal): Promise<ImageGenerationResult>;
}

/**
 * Verdict returned by the multimodal image review client. The reviewer is the
 * same fixed image model (`LLM_IMAGE_MODEL`, e.g. gemini-flash-image), invoked
 * through `/chat/completions` with an `image_url` content part instead of the
 * `/images/generations` path used for generation.
 *
 * - `pass` — the image matches the brief; no regeneration needed.
 * - `fail` — the reviewer flagged concrete issues; the caller may regenerate
 *   with the supplied `suggestion` as additional prompt guidance.
 */
export type ImageReviewVerdict = 'pass' | 'fail';

export interface ImageReviewRequest {
  /** Raw image bytes to be reviewed. */
  imageBytes: Uint8Array;
  /** MIME type of {@link ImageReviewRequest.imageBytes}. */
  mimeType: ImageMimeType;
  /**
   * Brief the image is expected to satisfy — typically the canonical content
   * the visual was generated from, plus the agreed visual concept. Bounded to
   * 4,000 UTF-8 bytes by the client.
   */
  brief: string;
}

export interface ImageReviewResult {
  score: number;
  /** Concrete, actionable issues when `score < 85`. Empty for passing scores. */
  issues: string[];
  /**
   * Optional suggestion the caller can append to the next generation prompt.
   * Empty for passing scores.
   */
  suggestion: string;
  /** Model id that produced the review (always `LLM_IMAGE_MODEL`). */
  model: string;
}

export interface ImageReviewClient {
  review(request: ImageReviewRequest, signal?: AbortSignal): Promise<ImageReviewResult>;
}
