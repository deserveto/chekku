// Node module-customization resolve hook that repairs Windows-broken ESM
// specifiers (`pdfjs-dist\legacy\build\pdf.mjs`) emitted by Mastra's bundler
// on win32 — see scripts/fix-mastra-specifiers.mjs for the build-time twin.
//
// Wired through NODE_OPTIONS=--import by scripts/mastra-dev.mjs so the server
// process `mastra dev` spawns inherits it; `mastra dev` re-bundles into
// agent/.mastra/output itself, so no build-script hook can cover the dev flow.
//
// A backslash in an ESM specifier is never legitimate in this repo: Node
// rejects it outright on every platform (ERR_INVALID_MODULE_SPECIFIER), so
// normalizing `\` to `/` can only turn broken imports into working ones.
const WIN_DRIVE_RE = /^[A-Za-z]:[\\/]/;

/**
 * Normalizes a module specifier that contains Windows separators.
 * Plain specifiers pass through unchanged; absolute Windows paths become
 * file:// URLs so they stay resolvable after normalization.
 */
export function normalizeWin32Specifier(specifier) {
  if (!specifier.includes('\\')) {
    return specifier;
  }
  const normalized = specifier.replaceAll('\\', '/');
  if (WIN_DRIVE_RE.test(normalized)) {
    return new URL(`file:///${normalized.replace(/^\/+/, '')}`).href;
  }
  return normalized;
}

export async function resolve(specifier, context, nextResolve) {
  return nextResolve(normalizeWin32Specifier(specifier), context);
}
