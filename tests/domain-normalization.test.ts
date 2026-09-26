import { describe, it, expect } from 'vitest';
import {
  normalizeHostname,
  isIpv4,
  isIpv6,
  matchSuffix,
  registrableDomain
} from '../core/domain/normalize.js';

describe('Domain Normalization', () => {
  it('normalizes uppercase hostnames to lowercase', () => {
    expect(normalizeHostname('EXAMPLE.COM')).toBe('example.com');
    expect(normalizeHostname('Sub.Domain.Example.Org')).toBe('sub.domain.example.org');
  });

  it('strips trailing dots safely', () => {
    expect(normalizeHostname('example.com.')).toBe('example.com');
    expect(normalizeHostname('tracker.net...')).toBe('tracker.net');
  });

  it('handles Unicode IDN and converts to Punycode', () => {
    const result = normalizeHostname('münchen.de');
    expect(result).toBe('xn--mnchen-3ya.de');
  });

  it('handles valid IPv4 and IPv6 addresses', () => {
    expect(normalizeHostname('127.0.0.1')).toBe('127.0.0.1');
    expect(isIpv4('192.168.1.1')).toBe(true);
    expect(isIpv4('999.999.999.999')).toBe(false);

    expect(normalizeHostname('[::1]')).toBe('::1');
    expect(isIpv6('2001:db8::1')).toBe(true);
  });

  it('rejects invalid hostnames safely returning empty string', () => {
    expect(normalizeHostname('')).toBe('');
    expect(normalizeHostname('   ')).toBe('');
    expect(normalizeHostname('-invalid.com')).toBe('');
    expect(normalizeHostname('invalid-.com')).toBe('');
    expect(normalizeHostname('singleword')).toBe('');
  });

  it('correctly distinguishes subdomain vs non-subdomain naive suffix match', () => {
    // evil.example.com is a subdomain of example.com
    expect(matchSuffix('evil.example.com', 'example.com')).toBe(true);

    // evilexample.com is NOT a subdomain of example.com
    expect(matchSuffix('evilexample.com', 'example.com')).toBe(false);
    expect(matchSuffix('notexample.com', 'example.com')).toBe(false);
  });

  it('extracts registrable domains accurately (including ccTLD multipart suffixes)', () => {
    expect(registrableDomain('sub.example.com')).toBe('example.com');
    expect(registrableDomain('deep.sub.news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableDomain('shop.amazon.co.jp')).toBe('amazon.co.jp');
  });
});
