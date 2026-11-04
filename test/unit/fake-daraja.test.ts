import { describe, expect, it } from 'vitest';
import { FakeDaraja, FakeHttpError, FakeTimeoutError } from '../../src/testing/fake-daraja.js';
import { PushRejectedError } from '../../src/transport.js';

const req = { phone: '254712345678', amount: 1500, accountRef: 'INV-1' };

describe('FakeDaraja', () => {
  it('registers a push and answers queries from the real outcome', async () => {
    const f = new FakeDaraja();
    const r = await f.stkPush(req);
    expect(await f.stkQuery(r.checkoutRequestId)).toEqual({ status: 'done', resultCode: 0 });
  });

  it('reject is a definitive refusal and registers nothing', async () => {
    const f = new FakeDaraja().scriptPush('reject');
    await expect(f.stkPush(req)).rejects.toBeInstanceOf(PushRejectedError);
    expect(f.registered.size).toBe(0);
  });

  it('http500 and hang are ambiguous and register nothing', async () => {
    const f = new FakeDaraja().scriptPush('http500', 'hang');
    await expect(f.stkPush(req)).rejects.toBeInstanceOf(FakeHttpError);
    await expect(f.stkPush(req)).rejects.toBeInstanceOf(FakeTimeoutError);
    expect(f.registered.size).toBe(0);
    expect(f.pushCalls).toHaveLength(2);
  });

  it('ok_but_response_lost registers a push the client never learns about', async () => {
    const f = new FakeDaraja().scriptPush('ok_but_response_lost');
    await expect(f.stkPush(req)).rejects.toBeInstanceOf(FakeTimeoutError);
    expect(f.registered.size).toBe(1);
  });

  it('query script overrides the real outcome and is consumed in order', async () => {
    const f = new FakeDaraja();
    const { checkoutRequestId: id } = await f.stkPush(req);
    f.scriptQuery(id, { kind: 'processing' }, { kind: 'error' }, { kind: 'done', resultCode: 1032 });
    expect(await f.stkQuery(id)).toEqual({ status: 'processing' });
    await expect(f.stkQuery(id)).rejects.toBeInstanceOf(FakeHttpError);
    expect(await f.stkQuery(id)).toEqual({ status: 'done', resultCode: 1032 });
    expect(await f.stkQuery(id)).toEqual({ status: 'done', resultCode: 0 });
  });

  it('callback bodies have Safaricom shape, and failures carry no receipt', async () => {
    const f = new FakeDaraja();
    const { checkoutRequestId: id } = await f.stkPush(req);
    const ok = JSON.parse(f.callbackBody(id)).Body.stkCallback;
    expect(ok.ResultCode).toBe(0);
    expect(ok.CallbackMetadata.Item.map((i: { Name: string }) => i.Name)).toContain('MpesaReceiptNumber');
    const bad = JSON.parse(f.callbackBody(id, { resultCode: 1032 })).Body.stkCallback;
    expect(bad.CallbackMetadata).toBeUndefined();
  });
});
