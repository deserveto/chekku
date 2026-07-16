import { describe, expect, it } from 'vitest';

import {
  createNamespacedObjectStorage,
  encodeAgentNamespace,
  validateRelativeObjectKey,
  validateRelativeObjectPrefix,
} from './namespaced-objects.ts';
import type { ObjectStorage } from './objects.ts';

function createMemoryStorage() {
  const objects = new Map<string, string>();
  const calls: Array<{ operation: string; key: string; extra?: unknown }> = [];
  const storage: ObjectStorage = {
    async ensureReady() {
      calls.push({ operation: 'ensureReady', key: '' });
    },
    async createText(key, value, contentType) {
      calls.push({ operation: 'createText', key, extra: contentType });
      objects.set(key, value);
    },
    async replaceText(key, value, contentType) {
      calls.push({ operation: 'replaceText', key, extra: contentType });
      objects.set(key, value);
    },
    async getText(key) {
      calls.push({ operation: 'getText', key });
      return objects.get(key) ?? '';
    },
    async exists(key) {
      calls.push({ operation: 'exists', key });
      return objects.has(key);
    },
    async delete(key) {
      calls.push({ operation: 'delete', key });
      objects.delete(key);
    },
    async listKeys(prefix, options) {
      calls.push({ operation: 'listKeys', key: prefix, extra: options });
      return {
        keys: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort(),
        truncated: false,
      };
    },
  };
  return { calls, objects, storage };
}

describe('relative object key validation', () => {
  it.each([
    '',
    '/absolute',
    'notes\\a.txt',
    '.',
    '..',
    'notes/./a.txt',
    'notes/../a.txt',
    'notes//a.txt',
    'notes/',
    'notes/\u0000a.txt',
    'notes/\u001fa.txt',
    'notes/\u007fa.txt',
    'a'.repeat(513),
    `${'界'.repeat(170)}abc`,
  ])('rejects unsafe key %j', (key) => {
    expect(() => validateRelativeObjectKey(key)).toThrow();
  });

  it.each([
    'a',
    'notes/a.txt',
    'a'.repeat(512),
    `${'界'.repeat(170)}ab`,
  ])('accepts safe key %j', (key) => {
    expect(validateRelativeObjectKey(key)).toBe(key);
  });
});

describe('relative object prefix validation', () => {
  it.each([
    '/absolute',
    'notes\\',
    '.',
    '..',
    'notes/./',
    'notes/../',
    'notes//a',
    'notes//',
    'notes/\u0000',
    'a'.repeat(513),
    `${'界'.repeat(170)}abc`,
  ])('rejects unsafe prefix %j', (prefix) => {
    expect(() => validateRelativeObjectPrefix(prefix)).toThrow();
  });

  it.each([
    '',
    'notes',
    'notes/',
    'notes/a',
    'a'.repeat(512),
    `${'界'.repeat(170)}ab`,
  ])('accepts safe prefix %j', (prefix) => {
    expect(validateRelativeObjectPrefix(prefix)).toBe(prefix);
  });
});

describe('agent namespace storage', () => {
  it('rejects an empty agent ID and base64url-encodes non-empty IDs', () => {
    expect(() => encodeAgentNamespace('')).toThrow();
    expect(encodeAgentNamespace('agent/alpha')).toBe(
      Buffer.from('agent/alpha').toString('base64url'),
    );
  });

  it('isolates agents and exposes only relative list keys', async () => {
    const root = createMemoryStorage();
    const alpha = createNamespacedObjectStorage(root.storage, 'agent/alpha');
    const beta = createNamespacedObjectStorage(root.storage, 'agent/alpha-2');

    await alpha.createText('notes/a.txt', 'alpha');
    await beta.createText('notes/a.txt', 'beta');

    expect([...root.objects.keys()].sort()).toEqual([
      `agents/${Buffer.from('agent/alpha').toString('base64url')}/notes/a.txt`,
      `agents/${Buffer.from('agent/alpha-2').toString('base64url')}/notes/a.txt`,
    ]);
    await expect(alpha.listKeys('notes/')).resolves.toEqual({
      keys: ['notes/a.txt'],
      truncated: false,
    });
  });

  it('maps every operation through its namespace and preserves arguments', async () => {
    const root = createMemoryStorage();
    const store = createNamespacedObjectStorage(root.storage, 'agent/alpha');
    const namespace = `agents/${encodeAgentNamespace('agent/alpha')}/`;

    await store.ensureReady?.();
    await store.createText('notes/a.txt', 'first', 'text/plain');
    await store.replaceText('notes/a.txt', 'second', 'text/markdown');
    await expect(store.getText('notes/a.txt')).resolves.toBe('second');
    await expect(store.exists('notes/a.txt')).resolves.toBe(true);
    await store.listKeys('', { limit: 37 });
    await store.delete('notes/a.txt');

    expect(root.calls).toEqual([
      { operation: 'ensureReady', key: '' },
      { operation: 'createText', key: `${namespace}notes/a.txt`, extra: 'text/plain' },
      { operation: 'replaceText', key: `${namespace}notes/a.txt`, extra: 'text/markdown' },
      { operation: 'getText', key: `${namespace}notes/a.txt` },
      { operation: 'exists', key: `${namespace}notes/a.txt` },
      { operation: 'listKeys', key: namespace, extra: { limit: 37 } },
      { operation: 'delete', key: `${namespace}notes/a.txt` },
    ]);
  });

  it('validates keys and prefixes before calling root storage', async () => {
    const root = createMemoryStorage();
    const store = createNamespacedObjectStorage(root.storage, 'agent/alpha');

    await expect(store.getText('../other-agent/secret')).rejects.toThrow();
    await expect(store.listKeys('notes//')).rejects.toThrow();
    expect(root.calls).toEqual([]);
  });
});
