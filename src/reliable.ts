import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { parseStkCallback } from './callback.js';
import { buildIpMatcher } from './ip.js';
import { next, TERMINAL, type ChargeView, type Event, type State } from './state.js';
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

export interface CallbackInput {
  /** The exact request bytes. Parse nothing before this: we need the raw body to retain it. */
  rawBody: string | Uint8Array;
  /**
   * The TCP peer address Safaricom connected from. Behind a proxy or load balancer `req.ip`
   * is the proxy's address unless trust-proxy is configured correctly; get this wrong and the
   * allowlist either rejects everything or trusts a spoofed X-Forwarded-For.
   */
  sourceIp: string;
}

export type CallbackReason =
  | 'applied'
  | 'untrusted_source'
  | 'malformed'
  | 'unknown_charge'
  | 'already_terminal'
  | 'not_applicable'
  | 'receipt_already_used';

export interface CallbackResult {
  /** True for exactly one delivery of a given outcome: the one that moved the charge. */
  applied: boolean;
  /** The charge was already terminal, so this delivery changed nothing. */
  duplicate: boolean;
  /** The payload disagrees with the terminal state (e.g. a late failure on a settled charge). */
  conflict: boolean;
  reason: CallbackReason;
  charge: Charge | null;
}

export interface ReliableOptions {
  transport: Transport;
  store: Store;
  /**
   * Exact IPs / IPv4 CIDRs Safaricom calls from. Take the list from Safaricom's current
   * documentation; this library deliberately ships none. 'disabled' turns the origin check off
   * and exists so that choice is explicit in your code.
   */
  trustedSourceIps: readonly string[] | 'disabled';
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface Reliable {
  charge(input: ChargeInput): Promise<ChargeResult>;
  /**
   * Always resolves for any input a caller might receive (bad body, wrong IP, unknown id,
   * duplicate) so the route can answer 200: Safaricom never retries. It rejects only when
   * persistence itself fails; answer 200 anyway and let the reconciler recover the charge.
   */
  handleCallback(input: CallbackInput): Promise<CallbackResult>;
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

const text = (b: string | Uint8Array): string => (typeof b === 'string' ? b : Buffer.from(b).toString('utf8'));

/** Postgres unique_violation on the receipt index. */
function isReceiptCollision(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; message?: string };
  return e?.code === '23505' && (e.constraint === 'dr_charges_receipt_uq' || /receipt/.test(e.message ?? ''));
}

export function createReliableDaraja(opts: ReliableOptions): Reliable {
  const { transport, store } = opts;
  const now = opts.now ?? (() => new Date());
  const trusted = opts.trustedSourceIps === 'disabled' ? null : buildIpMatcher(opts.trustedSourceIps);

  /**
   * Run an event through the pure machine, then compare-and-set it into the store.
   * `applied` is true only for the single caller whose CAS won.
   */
  async function apply(
    c: Charge,
    e: Event,
    patch?: { checkoutRequestId?: string; receipt?: string },
  ): Promise<{ charge: Charge; applied: boolean }> {
    const to = next(c as ChargeView, e);
    const ignored = (state: State | null) =>
      store.appendAudit({
        chargeId: c.id, checkoutRequestId: c.checkoutRequestId, kind: 'ignored',
        event: e, fromState: c.state, toState: state, rawPayload: null, at: now(),
      });

    if (to === null) {
      await ignored(null);
      return { charge: c, applied: false };
    }
    const updated = await store.transition(c.id, c.state, to, patch);
    if (!updated) {
      // Lost a race: someone else moved it first, and their state is authoritative.
      await ignored(null);
      return { charge: (await store.get(c.id)) ?? c, applied: false };
    }
    await store.appendAudit({
      chargeId: c.id, checkoutRequestId: updated.checkoutRequestId, kind: 'transition',
      event: e, fromState: c.state, toState: to, rawPayload: null, at: now(),
    });
    return { charge: updated, applied: true };
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
      return view((await apply(row, outcome, patch)).charge);
    },

    async handleCallback({ rawBody, sourceIp }) {
      const raw = text(rawBody);
      const audit = (kind: 'untrusted_source' | 'malformed' | 'callback_raw', c: Charge | null, checkoutRequestId: string | null) =>
        store.appendAudit({
          chargeId: c?.id ?? null, checkoutRequestId, kind,
          event: null, fromState: null, toState: null, rawPayload: raw, at: now(),
        });
      const result = (reason: CallbackReason, charge: Charge | null, extra: Partial<CallbackResult> = {}): CallbackResult => ({
        applied: false, duplicate: false, conflict: false, reason, charge, ...extra,
      });

      // 1. Origin. Safaricom does not sign callbacks, so this is the only gate on who may speak.
      //    A rejected call changes nothing but is retained: a spoofing attempt is evidence.
      if (trusted && !trusted(sourceIp)) {
        await audit('untrusted_source', null, null);
        return result('untrusted_source', null);
      }

      // 2. Parse. Malformed input is retained for replay and never throws.
      const cb = parseStkCallback(raw);
      if (!cb) {
        await audit('malformed', null, null);
        return result('malformed', null);
      }

      // 3. Bind to a charge by the id we stored from the push response.
      const charge = await store.getByCheckoutRequestId(cb.checkoutRequestId);
      await audit('callback_raw', charge, cb.checkoutRequestId); // durable before any state change
      if (!charge) return result('unknown_charge', null);

      // 4. Forward-only compare-and-set. The receipt rides along on success so that it is
      //    unique across charges: one receipt can settle at most one charge.
      const event: Event = { type: 'callback', resultCode: cb.resultCode };
      let applied: { charge: Charge; applied: boolean };
      try {
        applied = await apply(
          charge,
          event,
          cb.resultCode === 0 && cb.receipt !== null ? { receipt: cb.receipt } : undefined,
        );
      } catch (err) {
        if (isReceiptCollision(err)) {
          await store.appendAudit({
            chargeId: charge.id, checkoutRequestId: charge.checkoutRequestId, kind: 'ignored',
            event, fromState: charge.state, toState: null, rawPayload: null, at: now(),
          });
          return result('receipt_already_used', charge, { conflict: true });
        }
        throw err;
      }

      if (applied.applied) return { applied: true, duplicate: false, conflict: false, reason: 'applied', charge: applied.charge };

      const c = applied.charge;
      if (TERMINAL.has(c.state)) {
        // Duplicate or late. Flag it when the payload contradicts what we recorded.
        const conflict = (cb.resultCode === 0) !== (c.state === 'settled');
        return result('already_terminal', c, { duplicate: true, conflict });
      }
      return result('not_applicable', c);
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
