/**
 * Shared image-src allowlist for chat-rendered images.
 *
 * Both the markdown renderer and the tool-result image preview must accept
 * only explicit http(s), same-origin absolute-path, and data: URLs; anything
 * else (notably `javascript:`) is dropped. Server-generated today, but tool
 * output is model-influenced, so the check stays client-side too.
 */
export function isSafeImageSrc(src: string): boolean {
  // Protocol-relative URLs inherit the page's scheme and bypass the explicit
  // http(s) allowlist — reject before the same-origin '/' check.
  if (src.startsWith('//')) return false;
  return (
    src.startsWith('http://')
    || src.startsWith('https://')
    || src.startsWith('/')
    || src.startsWith('data:')
  );
}
