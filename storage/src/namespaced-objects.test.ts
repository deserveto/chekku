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

function createBinaryMemoryStorage() {
  const bytes = new Map<string, { value: Uint8Array; contentType?: string }>();
  const calls: Array<{ operation: string; key: string; extra?: unknown }> = [];
  const storage: ObjectStorage = {
    async createText(key, value) {
      bytes.set(key, { value: new TextEncoder().encode(value) });
    },
    async replaceText(key, value) {
      bytes.set(key, { value: new TextEncoder().encode(value) });
    },
    async getText(key) {
      const entry = bytes.get(key);
      return entry ? new TextDecoder().decode(entry.value) : '';
    },
    async exists(key) {
      return bytes.has(key);
    },
    async delete(key) {
      bytes.delete(key);
    },
    async listKeys(prefix) {
      return {
        keys: [...bytes.keys()].filter((key) => key.startsWith(prefix)).sort(),
        truncated: false,
      };
    },
    async createBytes(key, value, contentType) {
      calls.push({ operation: 'createBytes', key, extra: contentType });
      if (bytes.has(key)) {
        throw new Error(`Already exists: ${key}`);
      }
      bytes.set(key, { value: new Uint8Array(value), contentType });
    },
    async replaceBytes(key, value, contentType) {
      calls.push({ operation: 'replaceBytes', key, extra: contentType });
      bytes.set(key, { value: new Uint8Array(value), contentType });
    },
    async getBytes(key) {
      calls.push({ operation: 'getBytes', key });
      const entry = bytes.get(key);
      if (!entry) throw new Error(`Missing object: ${key}`);
      return { value: new Uint8Array(entry.value), ...(entry.contentType ? { contentType: entry.contentType } : {}) };
    },
  };
  return { bytes, calls, storage };
}

describe('agent namespace binary storage', () => {
  it('routes binary create and read through the agent namespace prefix', async () => {
    const root = createBinaryMemoryStorage();
    const store = createNamespacedObjectStorage(root.storage, 'social-media-agent');
    const namespace = `agents/${encodeAgentNamespace('social-media-agent')}/`;

    const image = new Uint8Array([0, 1, 2, 3]);
    await store.createBytes('social-posts/smp_1/visuals/sva_1.png', image, 'image/png');

    expect([...root.bytes.keys()]).toEqual([
      `${namespace}social-posts/smp_1/visuals/sva_1.png`,
    ]);

    await expect(store.getBytes('social-posts/smp_1/visuals/sva_1.png')).resolves.toEqual({
      value: image,
      contentType: 'image/png',
    });
  });

  it('isolates binary objects across agent namespaces', async () => {
    const root = createBinaryMemoryStorage();
    const social = createNamespacedObjectStorage(root.storage, 'social-media-agent');
    const foreign = createNamespacedObjectStorage(root.storage, 'other-agent');

    const image = new Uint8Array([10, 20]);
    await social.createBytes('social-posts/p1/visuals/v1.png', image, 'image/png');
    await foreign.createBytes('social-posts/p1/visuals/v1.png', new Uint8Array([99]), 'image/png');

    await expect(social.getBytes('social-posts/p1/visuals/v1.png')).resolves.toMatchObject({
      value: image,
    });
  });

  it('validates binary keys before calling root storage', async () => {
    const root = createBinaryMemoryStorage();
    const store = createNamespacedObjectStorage(root.storage, 'social-media-agent');

    await expect(store.createBytes('../escape', new Uint8Array([1]))).rejects.toThrow();
    await expect(store.getBytes('escape\\key')).rejects.toThrow();
    expect(root.calls).toEqual([]);
  });
});
