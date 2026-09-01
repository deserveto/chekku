// Fixes Windows-broken ESM import specifiers in `mastra build` output.
//
// On win32, Mastra's dependency-optimization pass emits module specifiers
// with native path separators (`pdfjs-dist\legacy\build\pdf.mjs`). Node's
// ESM loader rejects backslashed specifiers with ERR_INVALID_MODULE_SPECIFIER
// (and they would be wrong on POSIX too — backslash is a legal filename
// character there, so the import would point at a file that does not exist).
//
// This script rewrites every backslashed import/export specifier to forward
// slashes across `agent/.mastra/output/**/*.{mjs,js}`. On Linux/macOS build
// output it is a no-op: specifiers never contain backslashes there.
//
// Wired into the agent workspace build script after `mastra build`:
//   "build": "mastra build && node scripts/fix-mastra-specifiers.mjs"
// Upstream issue class: mastra-ai/mastra Windows bundler path handling
// (cf. the file:// URL fix in mastra#11329 — same family, different site).
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Rewrites backslashed module specifiers to forward slashes in ESM source.
 * Handles static imports/exports (`from '...'`), side-effect imports
 * (`import '...'`), and dynamic imports (`import('...')`). Specifiers are the
 * only module-resolution strings; all other backslashes (string content,
 * regexes) are left untouched.
 *
 * @returns {{ code: string, count: number }} rewritten source and how many
 * specifiers were normalized.
 */
export function rewriteSpecifiers(code) {
  // Group 1 keeps the keyword + whitespace/paren verbatim so untouched
  // matches keep their exact formatting. Group 3 is the specifier, matched
  // only when it contains at least one backslash. Module specifiers cannot
  // contain quotes, so the lazy quote-delimited match is safe.
  const SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]*\\[^'"]*)\2/g;
  let count = 0;
  const codeOut = code.replace(SPECIFIER_RE, (_match, keyword, quote, specifier) => {
    count += 1;
    return `${keyword}${quote}${specifier.replaceAll('\\', '/')}${quote}`;
  });
  return { code: codeOut, count };
}

async function collectFiles(dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, files);
    } else if (['.mjs', '.js'].includes(extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

export async function main(argv) {
  const target = argv[2] ?? join(import.meta.dirname, '..', 'agent', '.mastra', 'output');
  let files;
  try {
    files = await collectFiles(target);
  } catch {
    // Nothing to normalize (e.g. build ran elsewhere); never fail the build.
    console.log(`[fix-mastra-specifiers] no output directory at ${target}, skipping`);
    return;
  }
  let total = 0;
  let touched = 0;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const { code, count } = rewriteSpecifiers(source);
    if (count > 0) {
      await writeFile(file, code);
      touched += 1;
      total += count;
    }
  }
  console.log(
    `[fix-mastra-specifiers] normalized ${total} specifier${total === 1 ? '' : 's'} in ${touched} of ${files.length} files under ${target}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv);
}
