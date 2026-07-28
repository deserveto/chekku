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
