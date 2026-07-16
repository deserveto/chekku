import type { ObjectStorage } from './objects.ts';

const MAX_KEY_BYTES = 512;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

function validatePath(value: string, allowEmpty: boolean, allowTrailingSlash: boolean): string {
  if ((!allowEmpty && value.length === 0) || Buffer.byteLength(value, 'utf8') > MAX_KEY_BYTES) {
    throw new Error('Invalid object key.');
  }
  if (value.length === 0) return value;
  if (value.startsWith('/') || value.includes('\\') || CONTROL_CHARACTER.test(value)) {
    throw new Error('Invalid object key.');
  }

  const path = allowTrailingSlash && value.endsWith('/') ? value.slice(0, -1) : value;
  if (path.length === 0 || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Invalid object key.');
  }
  return value;
}

export function validateRelativeObjectKey(key: string): string {
  return validatePath(key, false, false);
}

export function validateRelativeObjectPrefix(prefix: string): string {
  return validatePath(prefix, true, true);
}

export function encodeAgentNamespace(agentId: string): string {
  if (agentId.length === 0) throw new Error('Agent ID is required.');
  return Buffer.from(agentId, 'utf8').toString('base64url');
}

export function createNamespacedObjectStorage(
  root: ObjectStorage,
  agentId: string,
): ObjectStorage {
  const namespace = `agents/${encodeAgentNamespace(agentId)}/`;
  const keyFor = (key: string): string => `${namespace}${validateRelativeObjectKey(key)}`;

  return {
    async ensureReady() {
      await root.ensureReady?.();
    },
    async createText(key, value, contentType) {
      await root.createText(keyFor(key), value, contentType);
    },
    async replaceText(key, value, contentType) {
      await root.replaceText(keyFor(key), value, contentType);
    },
    async getText(key) {
      return root.getText(keyFor(key));
    },
    async exists(key) {
      return root.exists(keyFor(key));
    },
    async delete(key) {
      await root.delete(keyFor(key));
    },
    async listKeys(prefix, options) {
      const relativePrefix = validateRelativeObjectPrefix(prefix);
      const result = await root.listKeys(`${namespace}${relativePrefix}`, options);
      return {
        keys: result.keys
          .filter((key) => key.startsWith(namespace))
          .map((key) => key.slice(namespace.length)),
        truncated: result.truncated,
      };
    },
  };
}
