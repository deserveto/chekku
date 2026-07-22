import ipaddr from 'ipaddr.js';

const ERROR = 'This URL is not allowed for public web reading.';
const RAW_CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_URL_BYTES = 2_048;
const LOCAL_NAMES = ['localhost', 'local', 'internal', 'home.arpa'] as const;
const IPV6_GLOBAL_RANGES = [
  ipaddr.IPv6.parseCIDR('2000::/3'),
  ipaddr.IPv6.parseCIDR('64:ff9b::/96'),
] as const;
const IPV6_NON_GLOBAL_RANGES = [
  ipaddr.IPv6.parseCIDR('2001::/23'),
  ipaddr.IPv6.parseCIDR('2001:db8::/32'),
  ipaddr.IPv6.parseCIDR('2002::/16'),
  ipaddr.IPv6.parseCIDR('3fff::/20'),
] as const;
const IPV6_GLOBAL_IETF_EXCEPTIONS = [
  ipaddr.IPv6.parseCIDR('2001:1::1/128'),
  ipaddr.IPv6.parseCIDR('2001:1::2/128'),
  ipaddr.IPv6.parseCIDR('2001:1::3/128'),
  ipaddr.IPv6.parseCIDR('2001:3::/32'),
  ipaddr.IPv6.parseCIDR('2001:4:112::/48'),
  ipaddr.IPv6.parseCIDR('2001:20::/28'),
  ipaddr.IPv6.parseCIDR('2001:30::/28'),
] as const;

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

function isGloballyRoutable(address: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  if (address.kind() === 'ipv4') return address.range() === 'unicast';
  const ipv6 = address as ipaddr.IPv6;
  if (IPV6_GLOBAL_IETF_EXCEPTIONS.some((range) => ipv6.match(range))) return true;
  if (IPV6_NON_GLOBAL_RANGES.some((range) => ipv6.match(range))) return false;
  return IPV6_GLOBAL_RANGES.some((range) => ipv6.match(range));
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
  if (address && !isGloballyRoutable(address)) reject();
  if (Buffer.byteLength(url.href, 'utf8') > MAX_URL_BYTES) reject();
  return url;
}
