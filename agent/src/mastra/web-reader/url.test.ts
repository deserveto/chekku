import { describe, expect, it } from 'vitest';

import { parsePublicWebUrl } from './url.js';

describe('public Web Reader URL', () => {
  it.each([
    ['https://example.com/path?topic=pm#features', 'https://example.com/path?topic=pm#features'],
    ['http://example.com:80/', 'http://example.com/'],
    ['https://example.com:443/', 'https://example.com/'],
    ['https://bücher.example/', 'https://xn--bcher-kva.example/'],
    ['https://8.8.8.8/', 'https://8.8.8.8/'],
    ['https://[2606:4700:4700::1111]/', 'https://[2606:4700:4700::1111]/'],
    ['https://[64:ff9b::808:808]/', 'https://[64:ff9b::808:808]/'],
    ['https://[::ffff:8.8.8.8]/', 'https://[::ffff:808:808]/'],
  ])('accepts public URL %s', (input, expected) => {
    expect(parsePublicWebUrl(input).href).toBe(expected);
  });

  it.each([
    'ftp://example.com/',
    '/relative',
    'https://user:pass@example.com/',
    'https://exa\tmple.com/',
    'https://example.com/path\nnext',
    'https://example.com/?q=bad\rvalue',
    'https://example.com/#bad\u007fvalue',
    'https://',
    'https://example.com:8443/',
    'https://localhost/',
    'https://api.localhost/',
    'https://local/',
    'https://printer.local/',
    'https://internal/',
    'https://service.internal/',
    'https://home.arpa/',
    'https://router.home.arpa/',
    'https://example.com./',
    'https://127.0.0.1/',
    'https://0.0.0.0/',
    'https://10.0.0.1/',
    'https://100.64.0.1/',
    'https://169.254.169.254/',
    'https://172.16.0.1/',
    'https://192.168.0.1/',
    'https://192.0.2.1/',
    'https://198.18.0.1/',
    'https://224.0.0.1/',
    'https://240.0.0.1/',
    'https://255.255.255.255/',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://0177.0.0.1/',
    'https://127.1/',
    'https://[::]/',
    'https://[::1]/',
    'https://[fe80::1]/',
    'https://[fc00::1]/',
    'https://[ff00::1]/',
    'https://[2001:db8::1]/',
    'https://[64:ff9b:1::7f00:1]/',
    'https://[100::1]/',
    'https://[2001:2::1]/',
    'https://[fec0::1]/',
    'https://[::7f00:1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:10.0.0.1]/',
    'https://[::ffff:100.64.0.1]/',
  ])('rejects unsafe URL %s', (input) => {
    expect(() => parsePublicWebUrl(input))
      .toThrow('This URL is not allowed for public web reading.');
  });

  it('enforces raw and normalized UTF-8 byte limits', () => {
    const prefix = 'https://example.com/';
    const exact = `${prefix}${'a'.repeat(2_048 - Buffer.byteLength(prefix))}`;
    expect(parsePublicWebUrl(exact).href).toBe(exact);
    expect(() => parsePublicWebUrl(`${exact}a`))
      .toThrow('This URL is not allowed for public web reading.');
    expect(() => parsePublicWebUrl(`https://example.com/${'雪'.repeat(680)}`))
      .toThrow('This URL is not allowed for public web reading.');
    expect(() => parsePublicWebUrl(`https://example.com/${'é'.repeat(350)}`))
      .toThrow('This URL is not allowed for public web reading.');
  });
});
