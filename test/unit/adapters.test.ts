import { describe, expect, it } from 'vitest';
import { kepasAdapter, type KepasLike } from '../../src/adapters/kepas.js';
import { fetchAdapter, password, timestamp } from '../../src/adapters/fetch.js';
import { PushRejectedError } from '../../src/transport.js';

const req = { phone: '254712345678', amount: 1500, accountRef: 'INV-1' };

/** Mimics kepas: it sets `error.name` to the class name. */
const named = (name: string, extra: object = {}) => Object.assign(new Error(name), { name }, extra);

function kepasWith(push: () => Promise<unknown>, query?: () => Promise<unknown>): KepasLike {
  return {
    collect: { stkPush: push as KepasLike['collect']['stkPush'] },
    status: { stkPush: (query ?? (async () => ({ responseCode: '0', resultCode: '0' }))) as KepasLike['status']['stkPush'] },
  };
}
const opts = { callbackUrl: 'https://x.test/cb' };

describe('kepasAdapter error mapping', () => {
  it.each([
    ['DarajaValidationError', {}],
    ['DarajaAuthError', {}],
    ['DarajaAPIError', {}], // HTTP 200, ResponseCode != 0
    ['DarajaHttpError', { httpStatus: 400 }],
    ['DarajaHttpError', { httpStatus: 404 }],
  ])('%s %j is a definitive refusal', async (name, extra) => {
    const t = kepasAdapter(kepasWith(async () => { throw named(name, extra); }), opts);
    await expect(t.stkPush(req)).rejects.toBeInstanceOf(PushRejectedError);
  });

  it.each([
    ['DarajaConnectionError', {}],
    ['DarajaHttpError', { httpStatus: 500 }],
    ['DarajaHttpError', { httpStatus: 503 }],
    ['SomethingNobodyHeardOf', {}],
  ])('%s %j is ambiguous and propagates unchanged', async (name, extra) => {
    const original = named(name, extra);
    const t = kepasAdapter(kepasWith(async () => { throw original; }), opts);
    const err = await t.stkPush(req).catch((e) => e);
    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(PushRejectedError);
  });

  it('non-Error throws are ambiguous', async () => {
    const t = kepasAdapter(kepasWith(async () => { throw 'boom'; }), opts);
    expect(await t.stkPush(req).catch((e) => e)).toBe('boom');
  });

  it('maps a success and passes our fields through', async () => {
    let seen: unknown;
    const t = kepasAdapter(
      kepasWith(async () => ({ checkoutRequestId: 'ws_CO_1', merchantRequestId: 'm1' })),
      { ...opts, description: 'Sub' },
    );
    const k = kepasWith(async (...a: unknown[]) => { seen = a[0]; return { checkoutRequestId: 'c', merchantRequestId: 'm' }; });
    await kepasAdapter(k, { ...opts, description: 'Sub' }).stkPush(req);
    expect(seen).toMatchObject({ phone: '254712345678', amount: 1500, accountReference: 'INV-1', description: 'Sub', callbackUrl: 'https://x.test/cb' });
    expect(await t.stkPush(req)).toEqual({ checkoutRequestId: 'ws_CO_1', merchantRequestId: 'm1' });
  });

  it('converts the string ResultCode from the query to a number', async () => {
    const t = kepasAdapter(kepasWith(async () => ({}), async () => ({ responseCode: '0', resultCode: '1032' })), opts);
    expect(await t.stkQuery('x')).toEqual({ status: 'done', resultCode: 1032 });
  });

  it('an empty ResultCode is "processing"; a query that throws propagates (no guess)', async () => {
    const p = kepasAdapter(kepasWith(async () => ({}), async () => ({ responseCode: '0', resultCode: '' })), opts);
    expect(await p.stkQuery('x')).toEqual({ status: 'processing' });
    const e = kepasAdapter(kepasWith(async () => ({}), async () => { throw named('DarajaHttpError', { httpStatus: 500 }); }), opts);
    await expect(e.stkQuery('x')).rejects.toThrow();
  });
});

describe('fetchAdapter', () => {
  const base = { consumerKey: 'k', consumerSecret: 's', shortcode: '174379', passkey: 'pk', callbackUrl: 'https://x.test/cb', environment: 'sandbox' as const };

  function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown } | Promise<never>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).includes('/oauth/')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: '3599' }), { status: 200 });
      }
      const r = await handler(String(url), init ?? {});
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
    }) as typeof fetch;
    return { f, calls };
  }

  it('sends PartyA/PhoneNumber as JSON numbers, a UTC timestamp, and the right password', async () => {
    const { f, calls } = mockFetch(() => ({ body: { ResponseCode: '0', CheckoutRequestID: 'ws_CO_9', MerchantRequestID: 'm9' } }));
    const r = await fetchAdapter({ ...base, fetch: f }).stkPush(req);
    expect(r).toEqual({ checkoutRequestId: 'ws_CO_9', merchantRequestId: 'm9' });

    const push = calls.find((c) => c.url.includes('processrequest'))!;
    const body = JSON.parse(String(push.init.body));
    expect(body.PartyA).toBe(254712345678);
    expect(body.PhoneNumber).toBe(254712345678);
    expect(body.Timestamp).toMatch(/^\d{14}$/);
    expect(body.Password).toBe(password('174379', 'pk', body.Timestamp));
    expect((push.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('caches the OAuth token across calls', async () => {
    const { f, calls } = mockFetch(() => ({ body: { ResponseCode: '0', CheckoutRequestID: 'a', MerchantRequestID: 'b' } }));
    const t = fetchAdapter({ ...base, fetch: f });
    await t.stkPush(req);
    await t.stkPush(req);
    expect(calls.filter((c) => c.url.includes('/oauth/'))).toHaveLength(1);
  });

  it('ResponseCode != 0 and 4xx are refusals; 5xx and non-JSON 200 are ambiguous', async () => {
    const run = async (r: { status?: number; body: unknown }) =>
      fetchAdapter({ ...base, fetch: mockFetch(() => r).f }).stkPush(req).catch((e) => e);

    expect(await run({ body: { ResponseCode: '1', ResponseDescription: 'nope' } })).toBeInstanceOf(PushRejectedError);
    expect(await run({ status: 400, body: { errorMessage: 'Bad Request' } })).toBeInstanceOf(PushRejectedError);
    expect(await run({ status: 401, body: 'x' })).toBeInstanceOf(PushRejectedError);

    for (const ambiguous of [await run({ status: 500, body: 'x' }), await run({ status: 503, body: 'x' }), await run({ body: '<html>ok</html>' })]) {
      expect(ambiguous).toBeInstanceOf(Error);
      expect(ambiguous).not.toBeInstanceOf(PushRejectedError);
    }
  });

  it('a hung request times out as an ambiguous error and is not retried', async () => {
    let pushes = 0;
    const f = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('/oauth/')) return new Response(JSON.stringify({ access_token: 't', expires_in: '3599' }));
      pushes++;
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }) as typeof fetch;
    const err = await fetchAdapter({ ...base, fetch: f, timeoutMs: 20 }).stkPush(req).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PushRejectedError);
    expect(pushes).toBe(1);
  });

  it('query: parses ResultCode, treats a missing one as processing, propagates 5xx', async () => {
    const q = (r: { status?: number; body: unknown }) => fetchAdapter({ ...base, fetch: mockFetch(() => r).f }).stkQuery('ws_CO_9').catch((e) => e);
    expect(await q({ body: { ResponseCode: '0', ResultCode: '1032' } })).toEqual({ status: 'done', resultCode: 1032 });
    expect(await q({ body: { ResponseCode: '0' } })).toEqual({ status: 'processing' });
    expect(await q({ status: 500, body: 'x' })).toBeInstanceOf(Error);
  });

  it('timestamp is zero-padded UTC', () => {
    expect(timestamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe('20260102030405');
  });
});
