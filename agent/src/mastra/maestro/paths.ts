import { resolve } from 'node:path';

const cache = new Map<string, string>();

export function resolveAbsolutePath(base: string, input: string): string {
  const key = `${base}\0${input}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const resolved = resolve(base, input);
  cache.set(key, resolved);
  return resolved;
}

export function resetPathCache(): void {
  cache.clear();
}

export function cacheSize(): number {
  return cache.size;
}
