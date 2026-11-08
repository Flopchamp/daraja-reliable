import { Buffer } from 'node:buffer';
import {
  PushRejectedError,
  type StkPushRequest,
  type StkPushResponse,
  type StkQueryResponse,
  type Transport,
} from '../transport.js';

export interface FetchAdapterOptions {
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  callbackUrl: string;
  environment: 'sandbox' | 'production';
  description?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

class HttpStatusError extends Error {
  constructor(readonly httpStatus: number, body: string) {
    super(`Daraja HTTP ${httpStatus}: ${body.slice(0, 200)}`);
    this.name = 'HttpStatusError';
  }
}

/** YYYYMMDDHHMMSS in UTC, zero padded. */
export function timestamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** base64(shortcode + passkey + timestamp): order matters. */
export function password(shortcode: string, passkey: string, ts: string): string {
  return Buffer.from(`${shortcode}${passkey}${ts}`).toString('base64');
}

/**
 * Raw `fetch` transport. Mirrors the gotchas kepas documents: PartyA/PhoneNumber must be JSON
 * numbers (strings silently 1037-time-out in production), UTC timestamp, password order.
 * Never retries a push: a retry after an ambiguous failure could prompt the customer twice.
 */
export function fetchAdapter(o: FetchAdapterOptions): Transport {
  const base = o.environment === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  const doFetch = o.fetch ?? globalThis.fetch;
  const timeoutMs = o.timeoutMs ?? 30_000;
  let token: { value: string; expires: number } | null = null;

  async function call(path: string, init: RequestInit): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, { ...init, signal: ctl.signal });
      const text = await res.text();
      if (!res.ok) throw new HttpStatusError(res.status, text);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('Daraja returned a non-JSON 200 body'); // ambiguous: may have been queued
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function getToken(): Promise<string> {
    if (token && token.expires > Date.now() + 30_000) return token.value;
    const basic = Buffer.from(`${o.consumerKey}:${o.consumerSecret}`).toString('base64');
    const r = (await call('/oauth/v1/generate?grant_type=client_credentials', {
      method: 'GET',
      headers: { authorization: `Basic ${basic}` },
    })) as { access_token?: string; expires_in?: string };
    if (!r.access_token) throw new HttpStatusError(401, 'no access_token in OAuth response');
    token = { value: r.access_token, expires: Date.now() + Number(r.expires_in ?? 3599) * 1000 };
    return token.value;
  }

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const t = await getToken();
    return (await call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify(body),
    })) as Record<string, unknown>;
  }

  return {
    async stkPush(req: StkPushRequest): Promise<StkPushResponse> {
      const ts = timestamp();
      const phone = Number(req.phone);
      let raw: Record<string, unknown>;
      try {
        raw = await post('/mpesa/stkpush/v1/processrequest', {
          BusinessShortCode: o.shortcode,
          Password: password(o.shortcode, o.passkey, ts),
          Timestamp: ts,
          TransactionType: 'CustomerPayBillOnline',
          Amount: req.amount,
          PartyA: phone,
          PartyB: o.shortcode,
          PhoneNumber: phone,
          CallBackURL: o.callbackUrl,
          AccountReference: req.accountRef,
          TransactionDesc: o.description ?? 'Payment',
        });
      } catch (err) {
        // 4xx (incl. 401) means Safaricom did not accept the request. 5xx, timeouts and
        // network errors are ambiguous and propagate unchanged.
        if (err instanceof HttpStatusError && err.httpStatus < 500) throw new PushRejectedError(err.message);
        throw err;
      }
      if (raw.ResponseCode !== '0') {
        throw new PushRejectedError(`ResponseCode ${String(raw.ResponseCode)}: ${String(raw.ResponseDescription ?? '')}`);
      }
      return {
        checkoutRequestId: String(raw.CheckoutRequestID ?? ''),
        merchantRequestId: String(raw.MerchantRequestID ?? ''),
      };
    },

    async stkQuery(checkoutRequestId: string): Promise<StkQueryResponse> {
      const ts = timestamp();
      const raw = await post('/mpesa/stkpushquery/v1/query', {
        BusinessShortCode: o.shortcode,
        Password: password(o.shortcode, o.passkey, ts),
        Timestamp: ts,
        CheckoutRequestID: checkoutRequestId,
      });
      if (raw.ResultCode === undefined || raw.ResultCode === '') return { status: 'processing' };
      const code = Number(raw.ResultCode);
      if (!Number.isFinite(code)) throw new Error(`unparseable ResultCode "${String(raw.ResultCode)}"`);
      return { status: 'done', resultCode: code };
    },
  };
}
