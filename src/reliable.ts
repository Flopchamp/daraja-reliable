import { createHash } from 'node:crypto';
import { next, type ChargeView, type Event, type State } from './state.js';
import type { Charge, Store } from './store.js';
import { PushRejectedError, type Transport } from './transport.js';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Same idempotency key, different phone/amount/accountRef. Never silently returns the original. */
export class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`idempotency key "${idempotencyKey}" was already used with different parameters`);
    this.name = 'IdempotencyConflictError';
  }
}

export interface ChargeInput {
  idempotencyKey: string;
  /** E.164 digits without '+', e.g. 254712345678. */
  phone: string;
  /** Whole KES. */
  amount: number;
  accountRef: string;
}

export interface ChargeResult {
  id: string;
  state: State;
  checkoutRequestId: string | null;
  /** True when this key was already known and nothing was sent to the transport. */
  replayed: boolean;
}

export interface ReliableOptions {
  transport: Transport;
  store: Store;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface Reliable {
  charge(input: ChargeInput): Promise<ChargeResult>;
  /**
   * Crash recovery. A charge left `pending` longer than `olderThanMs` lost its push
   * response; it becomes `push_unknown`. This NEVER re-pushes.
   */
  recover(opts: { olderThanMs: number }): Promise<Charge[]>;
}

export function fingerprint(i: Pick<ChargeInput, 'phone' | 'amount' | 'accountRef'>): string {
  return createHash('sha256').update(`${i.phone}|${i.amount}|${i.accountRef}`).digest('hex');
}

function validate(i: ChargeInput): void {
  if (!i.idempotencyKey) throw new ValidationError('idempotencyKey is required');
  if (!/^254\d{9}$/.test(i.phone)) throw new ValidationError('phone must look like 254712345678');
  if (!Number.isInteger(i.amount) || i.amount <= 0) throw new ValidationError('amount must be a positive whole number of KES');
  if (!i.accountRef) throw new ValidationError('accountRef is required');
}

const view = (c: Charge): ChargeResult => ({
  id: c.id,
  state: c.state,
  checkoutRequestId: c.checkoutRequestId,
  replayed: false,
});

export function createReliableDaraja(opts: ReliableOptions): Reliable {
  const { transport, store } = opts;
  const now = opts.now ?? (() => new Date());

  /** Apply an event through the pure machine, then CAS it into the store; audit either way. */
  async function apply(c: Charge, e: Event, patch?: { checkoutRequestId?: string }): Promise<Charge> {
    const cv: ChargeView = c;
    const to = next(cv, e);
    if (to === null) {
      await store.appendAudit({
        chargeId: c.id, checkoutRequestId: c.checkoutRequestId, kind: 'ignored',
        event: e, fromState: c.state, toState: null, rawPayload: null, at: now(),
      });
      return c;
    }
    const updated = await store.transition(c.id, c.state, to, patch);
    if (!updated) {
      // Lost a race: someone else moved it first. Their state is authoritative.
      return (await store.get(c.id)) ?? c;
    }
    await store.appendAudit({
      chargeId: c.id, checkoutRequestId: updated.checkoutRequestId, kind: 'transition',
      event: e, fromState: c.state, toState: to, rawPayload: null, at: now(),
    });
    return updated;
  }

  return {
    async charge(input) {
      validate(input);
      const fp = fingerprint(input);

      // 1. Intent is durable BEFORE anything leaves the process.
      const { charge: row, created } = await store.insertIntent({
        idempotencyKey: input.idempotencyKey,
        fingerprint: fp,
        phone: input.phone,
        amount: input.amount,
        accountRef: input.accountRef,
      });

      if (!created) {
        if (row.fingerprint !== fp) throw new IdempotencyConflictError(input.idempotencyKey);
        return { ...view(row), replayed: true };
      }

      // 2. Only the caller that created the row pushes. Map the outcome conservatively:
      //    a definitive refusal fails the charge; anything else may have reached the customer.
      //    The transport call is isolated so that a store error while RECORDING the outcome
      //    is never mistaken for a transport outcome: it propagates, the row stays `pending`,
      //    and recover() turns it into push_unknown.
      let outcome: Event;
      let patch: { checkoutRequestId?: string } | undefined;
      try {
        const r = await transport.stkPush({ phone: input.phone, amount: input.amount, accountRef: input.accountRef });
        outcome = { type: 'push_accepted', checkoutRequestId: r.checkoutRequestId };
        patch = { checkoutRequestId: r.checkoutRequestId };
      } catch (err) {
        outcome =
          err instanceof PushRejectedError
            ? { type: 'push_rejected', reason: err.message }
            : { type: 'push_ambiguous' };
      }
      return view(await apply(row, outcome, patch));
    },

    async recover({ olderThanMs }) {
      const before = new Date(now().getTime() - olderThanMs);
      const moved = await store.markStalePending(before);
      for (const c of moved) {
        await store.appendAudit({
          chargeId: c.id, checkoutRequestId: null, kind: 'transition',
          event: { type: 'push_ambiguous' }, fromState: 'pending', toState: 'push_unknown',
          rawPayload: null, at: now(),
        });
      }
      return moved;
    },
  };
}
