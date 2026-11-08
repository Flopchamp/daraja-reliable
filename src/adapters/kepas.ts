import {
  PushRejectedError,
  type StkPushRequest,
  type StkPushResponse,
  type StkQueryResponse,
  type Transport,
} from '../transport.js';

/**
 * The slice of `@kepas/daraja-js` (^1.6) this adapter uses, as a structural type so the
 * package is not a hard dependency. Pass `new Daraja({...})`.
 */
export interface KepasLike {
  collect: {
    stkPush(input: {
      phone: string;
      amount: number;
      accountReference: string;
      description: string;
      callbackUrl: string;
    }): Promise<{ checkoutRequestId: string; merchantRequestId: string }>;
  };
  status: {
    stkPush(input: { checkoutRequestId: string }): Promise<{ responseCode: string; resultCode: string }>;
  };
}

export interface KepasAdapterOptions {
  callbackUrl: string;
  description?: string;
}

/**
 * Classify a thrown kepas error. kepas sets `error.name` to the class name, so we match on
 * that instead of importing its classes (the HTTP error class is not exported).
 *
 *  - refused before or by Safaricom, nothing in flight: validation, auth (401), 4xx,
 *    and DarajaAPIError (HTTP 200 with ResponseCode != 0)
 *  - anything else (5xx, timeout, network, unknown): ambiguous, so it is rethrown unchanged
 *    and the core records push_unknown.
 */
function classify(err: unknown): 'rejected' | 'ambiguous' {
  if (typeof err !== 'object' || err === null) return 'ambiguous';
  const e = err as { name?: unknown; httpStatus?: unknown };
  if (typeof e.httpStatus === 'number') return e.httpStatus >= 500 ? 'ambiguous' : 'rejected';
  switch (e.name) {
    case 'DarajaValidationError':
    case 'DarajaAuthError':
    case 'DarajaAPIError':
    case 'DarajaInsufficientFundsError':
    case 'DarajaUserUnreachableError':
    case 'DarajaCancelledError':
      return 'rejected';
    default:
      return 'ambiguous'; // includes DarajaConnectionError and anything unrecognised
  }
}

export function kepasAdapter(daraja: KepasLike, o: KepasAdapterOptions): Transport {
  return {
    async stkPush(req: StkPushRequest): Promise<StkPushResponse> {
      try {
        const r = await daraja.collect.stkPush({
          phone: req.phone,
          amount: req.amount,
          accountReference: req.accountRef,
          description: o.description ?? 'Payment',
          callbackUrl: o.callbackUrl,
        });
        return { checkoutRequestId: r.checkoutRequestId, merchantRequestId: r.merchantRequestId };
      } catch (err) {
        if (classify(err) === 'rejected') {
          throw new PushRejectedError(err instanceof Error ? err.message : 'push rejected');
        }
        throw err;
      }
    },

    async stkQuery(checkoutRequestId: string): Promise<StkQueryResponse> {
      const r = await daraja.status.stkPush({ checkoutRequestId });
      // kepas returns ResultCode as a string. An empty one means no verdict yet.
      if (r.resultCode === '') return { status: 'processing' };
      const code = Number(r.resultCode);
      if (!Number.isFinite(code)) throw new Error(`unparseable ResultCode "${r.resultCode}"`);
      return { status: 'done', resultCode: code };
    },
  };
}
