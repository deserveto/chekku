import ipaddr from 'ipaddr.js';

const ERROR = 'This URL is not allowed for public web reading.';
const RAW_CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_URL_BYTES = 2_048;
const LOCAL_NAMES = ['localhost', 'local', 'internal', 'home.arpa'] as const;

export class PublicWebUrlError extends Error {
  constructor() {
    super(ERROR);
  }
}

function reject(): never {
  throw new PublicWebUrlError();
}

function isLocalName(hostname: string): boolean {
  return LOCAL_NAMES.some((name) =>
    hostname === name || hostname.endsWith(`.${name}`));
}

function literalAddress(hostname: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (!ipaddr.isValid(unwrapped)) return undefined;
  return ipaddr.process(unwrapped);
}

export function parsePublicWebUrl(value: string): URL {
  if (RAW_CONTROL.test(value)) reject();
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > MAX_URL_BYTES) reject();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return reject();
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
    || !url.hostname
    || url.hostname.endsWith('.')
    || (url.port && url.port !== (url.protocol === 'http:' ? '80' : '443'))) {
    reject();
  }

  const hostname = url.hostname.toLowerCase();
  if (isLocalName(hostname)) reject();
  const address = literalAddress(hostname);
  if (address && address.range() !== 'unicast') reject();
  if (Buffer.byteLength(url.href, 'utf8') > MAX_URL_BYTES) reject();
  return url;
}
