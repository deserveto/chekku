import ipaddr from 'ipaddr.js';

const ERROR = 'This URL is not allowed for public web reading.';
const RAW_CONTROL = /[\u0000-\u001f\u007f]/;
const TERMINAL_DOT_AUTHORITY =
  /(?:[.\u3002\uff0e\uff61]|%2e|%e3%80%82|%ef%bc%8e|%ef%bd%a1)(?::[0-9]*)?$/i;
const MAX_URL_BYTES = 2_048;
const LOCAL_NAMES = ['localhost', 'local', 'internal', 'home.arpa'] as const;
const IPV4_TRANSLATION_PREFIX = ipaddr.IPv6.parseCIDR('64:ff9b::/96');
const IPV6_GLOBAL_RANGES = [
  ipaddr.IPv6.parseCIDR('2000::/3'),
  IPV4_TRANSLATION_PREFIX,
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

function hasTerminalDotAuthority(value: string): boolean {
  const scheme = /^https?:/i.exec(value);
  if (!scheme) return false;
  let authorityStart = scheme[0].length;
  while (value[authorityStart] === '/' || value[authorityStart] === '\\') {
    authorityStart += 1;
  }
  const remainder = value.slice(authorityStart);
  const delimiter = remainder.search(/[\\/?#]/);
  const authority = delimiter === -1 ? remainder : remainder.slice(0, delimiter);
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  return TERMINAL_DOT_AUTHORITY.test(hostPort);
}

function literalAddress(hostname: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (!ipaddr.isValid(unwrapped)) return undefined;
  return ipaddr.process(unwrapped);
}

function isGloballyRoutableIpv4(address: ipaddr.IPv4): boolean {
  return address.range() === 'unicast';
}

function rfc6052Ipv4(address: ipaddr.IPv6): ipaddr.IPv4 {
  const octets = address.parts.slice(-2)
    .flatMap((part) => [part >> 8, part & 0xff]);
  return new ipaddr.IPv4(octets);
}

function isGloballyRoutable(address: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  if (address.kind() === 'ipv4') return isGloballyRoutableIpv4(address as ipaddr.IPv4);
  const ipv6 = address as ipaddr.IPv6;
  if (ipv6.match(IPV4_TRANSLATION_PREFIX)) {
    return isGloballyRoutableIpv4(rfc6052Ipv4(ipv6));
  }
  if (IPV6_GLOBAL_IETF_EXCEPTIONS.some((range) => ipv6.match(range))) return true;
  if (IPV6_NON_GLOBAL_RANGES.some((range) => ipv6.match(range))) return false;
  return IPV6_GLOBAL_RANGES.some((range) => ipv6.match(range));
}

export function parsePublicWebUrl(value: string): URL {
  if (RAW_CONTROL.test(value)) reject();
  const trimmed = value.trim();
  if (!trimmed
    || Buffer.byteLength(trimmed, 'utf8') > MAX_URL_BYTES
    || hasTerminalDotAuthority(trimmed)) reject();

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
