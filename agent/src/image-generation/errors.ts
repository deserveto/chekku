/**
 * Fixed, safe error categories for the image-generation provider boundary.
 *
 * Every provider failure is normalized to one of these categories with a fixed
 * message. The messages never expose the endpoint URL, API key, request body,
 * response body, headers, diagnostics, or request ids — mirrors the bounded
 * client pattern used by the hosted Web Reader.
 */

export type ImageGenerationErrorCategory =
  | 'configuration'
  | 'cancelled'
  | 'timeout'
  | 'unavailable'
  | 'format'
  | 'tooLarge'
  | 'invalid';

const ERROR_MESSAGES: Record<ImageGenerationErrorCategory, string> = {
  configuration: 'Image generation is not configured.',
  cancelled: 'Image generation request was cancelled.',
  timeout: 'Image generation timed out. Try again.',
  unavailable: 'Image generation is unavailable. Try again later.',
  format: 'Image generation returned an unsupported format.',
  tooLarge: 'Image generation returned too much data.',
  invalid: 'Image generation returned an invalid response.',
};

export class ImageGenerationClientError extends Error {
  constructor(readonly category: ImageGenerationErrorCategory) {
    super(ERROR_MESSAGES[category]);
    this.name = 'ImageGenerationClientError';
  }
}

export function isImageGenerationClientError(
  value: unknown,
): value is ImageGenerationClientError {
  return value instanceof ImageGenerationClientError;
}
