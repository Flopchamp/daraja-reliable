/**
 * The only thing this library needs from an SDK. Adapters (kepas, raw fetch) implement it.
 *
 * Error contract for `stkPush`:
 *  - throw PushRejectedError  -> Safaricom (or validation) definitively refused; nothing is in flight
 *  - throw anything else      -> treated as AMBIGUOUS (timeout, 5xx, network, unknown class)
 */
export interface StkPushRequest {
  phone: string;
  amount: number;
  accountRef: string;
}

export interface StkPushResponse {
  checkoutRequestId: string;
  merchantRequestId: string;
}

export type StkQueryResponse =
  | { status: 'processing' }
  | { status: 'done'; resultCode: number };

export interface Transport {
  stkPush(req: StkPushRequest): Promise<StkPushResponse>;
  /** Throws on any failure to get an answer (network, 5xx). Never returns a guess. */
  stkQuery(checkoutRequestId: string): Promise<StkQueryResponse>;
}

export class PushRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushRejectedError';
  }
}
