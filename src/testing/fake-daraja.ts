import {
  PushRejectedError,
  type StkPushRequest,
  type StkPushResponse,
  type StkQueryResponse,
  type Transport,
} from '../transport.js';

/** What the next `stkPush` call does. Scripts are consumed in order; default is 'ok'. */
export type PushBehaviour =
  | 'ok'
  | 'reject' // definitive refusal
  | 'http500' // ambiguous: Safaricom may have queued it
  | 'hang' // ambiguous: never answers within the client timeout
  | 'ok_but_response_lost'; // push IS registered at Safaricom, client sees a network error

export type QueryBehaviour =
  | { kind: 'done'; resultCode: number }
  | { kind: 'processing' }
  | { kind: 'error' }; // 5xx / network

export class FakeTimeoutError extends Error {
  constructor() {
    super('fake daraja: request timed out');
    this.name = 'FakeTimeoutError';
  }
}
export class FakeHttpError extends Error {
  constructor(readonly status: number) {
    super(`fake daraja: HTTP ${status}`);
    this.name = 'FakeHttpError';
  }
}

interface Registered {
  checkoutRequestId: string;
  merchantRequestId: string;
  req: StkPushRequest;
  /** What the "real" outcome is, used by default stkQuery. */
  outcome: { resultCode: number };
}

/**
 * Scriptable stand-in for Safaricom. Safaricom's sandbox only exercises the happy
 * path; this lets tests inject the failures that only occur in production.
 */
export class FakeDaraja implements Transport {
  private n = 0;
  private pushScript: PushBehaviour[] = [];
  private queryScript = new Map<string, QueryBehaviour[]>();
  readonly registered = new Map<string, Registered>();
  /** Every stkPush call that reached the fake, including ones whose response was lost. */
  readonly pushCalls: StkPushRequest[] = [];
  readonly queryCalls: string[] = [];
  /** How long 'hang' blocks before the client-side timeout fires. */
  hangMs = 10;
  /** Latency applied to a successful push, so concurrent callers genuinely overlap. */
  latencyMs = 0;
  defaultOutcome = 0;

  scriptPush(...b: PushBehaviour[]): this {
    this.pushScript.push(...b);
    return this;
  }

  scriptQuery(checkoutRequestId: string, ...b: QueryBehaviour[]): this {
    const q = this.queryScript.get(checkoutRequestId) ?? [];
    q.push(...b);
    this.queryScript.set(checkoutRequestId, q);
    return this;
  }

  async stkPush(req: StkPushRequest): Promise<StkPushResponse> {
    this.pushCalls.push(req);
    const behaviour = this.pushScript.shift() ?? 'ok';

    switch (behaviour) {
      case 'reject':
        throw new PushRejectedError('fake daraja: ResponseCode != 0');
      case 'http500':
        throw new FakeHttpError(500);
      case 'hang':
        await new Promise((r) => setTimeout(r, this.hangMs));
        throw new FakeTimeoutError();
      case 'ok_but_response_lost':
        this.register(req);
        throw new FakeTimeoutError();
      case 'ok': {
        if (this.latencyMs > 0) await new Promise((res) => setTimeout(res, this.latencyMs));
        const r = this.register(req);
        return { checkoutRequestId: r.checkoutRequestId, merchantRequestId: r.merchantRequestId };
      }
    }
  }

  async stkQuery(checkoutRequestId: string): Promise<StkQueryResponse> {
    this.queryCalls.push(checkoutRequestId);
    const scripted = this.queryScript.get(checkoutRequestId)?.shift();
    if (scripted) {
      if (scripted.kind === 'error') throw new FakeHttpError(500);
      if (scripted.kind === 'processing') return { status: 'processing' };
      return { status: 'done', resultCode: scripted.resultCode };
    }
    const reg = this.registered.get(checkoutRequestId);
    if (!reg) throw new FakeHttpError(404);
    return { status: 'done', resultCode: reg.outcome.resultCode };
  }

  /** Body shaped like Safaricom's STK callback (what the real endpoint POSTs). */
  callbackBody(
    checkoutRequestId: string,
    opts: { resultCode?: number; receipt?: string } = {},
  ): string {
    const reg = this.registered.get(checkoutRequestId);
    if (!reg) throw new Error(`unknown checkoutRequestId ${checkoutRequestId}`);
    const resultCode = opts.resultCode ?? reg.outcome.resultCode;
    const stk: Record<string, unknown> = {
      MerchantRequestID: reg.merchantRequestId,
      CheckoutRequestID: checkoutRequestId,
      ResultCode: resultCode,
      ResultDesc: resultCode === 0 ? 'The service request is processed successfully.' : 'failed',
    };
    if (resultCode === 0) {
      stk.CallbackMetadata = {
        Item: [
          { Name: 'Amount', Value: reg.req.amount },
          { Name: 'MpesaReceiptNumber', Value: opts.receipt ?? `R${checkoutRequestId.slice(-8)}` },
          { Name: 'PhoneNumber', Value: Number(reg.req.phone) },
        ],
      };
    }
    return JSON.stringify({ Body: { stkCallback: stk } });
  }

  private register(req: StkPushRequest): Registered {
    this.n += 1;
    const r: Registered = {
      checkoutRequestId: `ws_CO_${String(this.n).padStart(12, '0')}`,
      merchantRequestId: `mr-${this.n}`,
      req,
      outcome: { resultCode: this.defaultOutcome },
    };
    this.registered.set(r.checkoutRequestId, r);
    return r;
  }
}
