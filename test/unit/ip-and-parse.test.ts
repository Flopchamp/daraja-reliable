import { describe, expect, it } from 'vitest';
import { buildIpMatcher } from '../../src/ip.js';
import { parseStkCallback } from '../../src/callback.js';

describe('buildIpMatcher', () => {
  it('matches exact IPv4 addresses and nothing nearby', () => {
    const m = buildIpMatcher(['196.201.214.200']);
    expect(m('196.201.214.200')).toBe(true);
    expect(m('196.201.214.201')).toBe(false);
  });

  it('matches CIDR ranges at the edges', () => {
    const m = buildIpMatcher(['196.201.214.0/24']);
    expect(m('196.201.214.0')).toBe(true);
    expect(m('196.201.214.255')).toBe(true);
    expect(m('196.201.215.0')).toBe(false);
    expect(m('196.201.213.255')).toBe(false);
  });

  it('handles /32, /0 and non-byte-aligned prefixes', () => {
    expect(buildIpMatcher(['10.0.0.5/32'])('10.0.0.5')).toBe(true);
    expect(buildIpMatcher(['0.0.0.0/0'])('8.8.8.8')).toBe(true);
    const m = buildIpMatcher(['10.0.0.0/22']);
    expect(m('10.0.3.255')).toBe(true);
    expect(m('10.0.4.0')).toBe(false);
  });

  it('treats an IPv4-mapped IPv6 peer address as the IPv4 address', () => {
    expect(buildIpMatcher(['196.201.214.200'])('::ffff:196.201.214.200')).toBe(true);
    expect(buildIpMatcher(['196.201.214.0/24'])('::FFFF:196.201.214.9')).toBe(true);
  });

  it('IPv6 is exact-match only', () => {
    const m = buildIpMatcher(['2001:db8::1']);
    expect(m('2001:DB8::1')).toBe(true);
    expect(m('2001:db8::2')).toBe(false);
  });

  it('garbage input never matches, and an empty list matches nothing', () => {
    const m = buildIpMatcher(['196.201.214.0/24']);
    for (const bad of ['', 'not-an-ip', '999.1.1.1', '196.201.214', '196.201.214.1.1']) expect(m(bad)).toBe(false);
    expect(buildIpMatcher([])('1.2.3.4')).toBe(false);
  });

  it('rejects malformed config at startup rather than at runtime', () => {
    for (const bad of ['', 'abc', '1.2.3.4/33', '1.2.3.4/', '1.2.3.4/x', '1.2.3/24', '2001:db8::/32', '1.2.3.4/8/8', '300.1.1.1']) {
      expect(() => buildIpMatcher([bad]), bad).toThrow();
    }
  });
});

describe('parseStkCallback', () => {
  const body = (stk: object) => JSON.stringify({ Body: { stkCallback: stk } });

  it('parses a success with its receipt', () => {
    const r = parseStkCallback(
      body({
        MerchantRequestID: 'm1', CheckoutRequestID: 'ws_CO_1', ResultCode: 0,
        CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1 }, { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' }] },
      }),
    );
    expect(r).toEqual({ checkoutRequestId: 'ws_CO_1', merchantRequestId: 'm1', resultCode: 0, receipt: 'NLJ7RT61SV' });
  });

  it('parses a failure, which carries no metadata and no receipt', () => {
    expect(parseStkCallback(body({ CheckoutRequestID: 'ws_CO_1', ResultCode: 1032 }))).toEqual({
      checkoutRequestId: 'ws_CO_1', merchantRequestId: null, resultCode: 1032, receipt: null,
    });
  });

  it('accepts a numeric-string ResultCode rather than lose a payment', () => {
    expect(parseStkCallback(body({ CheckoutRequestID: 'a', ResultCode: '0' }))?.resultCode).toBe(0);
  });

  it('returns null for anything that is not a well-formed STK callback', () => {
    const bad = [
      '', 'not json', '{', 'null', '[]', '42', '"str"', '{}', '{"Body":{}}', '{"Body":{"stkCallback":null}}',
      body({}), body({ CheckoutRequestID: '', ResultCode: 0 }), body({ CheckoutRequestID: 'a' }),
      body({ CheckoutRequestID: 7, ResultCode: 0 }), body({ CheckoutRequestID: 'a', ResultCode: 'x' }),
      body({ CheckoutRequestID: 'a', ResultCode: '' }), body({ CheckoutRequestID: 'a', ResultCode: 1.5 }),
      body({ CheckoutRequestID: 'a', ResultCode: null }),
      'x'.repeat(70_000),
    ];
    for (const b of bad) expect(parseStkCallback(b), b.slice(0, 40)).toBeNull();
  });

  it('tolerates hostile metadata without throwing', () => {
    const hostile = [null, 'x', 5, [null, 1, 'x', { Name: 'MpesaReceiptNumber', Value: 9 }], { Item: 'x' }];
    for (const CallbackMetadata of hostile) {
      const r = parseStkCallback(body({ CheckoutRequestID: 'a', ResultCode: 0, CallbackMetadata }));
      expect(r?.receipt).toBeNull();
    }
  });
});
