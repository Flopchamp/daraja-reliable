import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { parseStkCallback } from './callback.js';
import { buildIpMatcher } from './ip.js';
import { next, QUERY_FAILURE_LIMIT, TERMINAL, type ChargeView, type Event, type State } from './state.js';
import type { Charge, OutboxType, Store } from './store.js';
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
  /**
   * How long a charge may wait for its callback before the reconciler asks Safaricom directly.
   * Safaricom never retries a callback, so this is a deadline, not a poll interval. Default 4 min.
   */
  callbackDeadlineMs?: number;
  /**
   * Extra time past the deadline during which a failed STK Push Query is NOT counted against a
   * charge. An STK query made while the customer is still deciding may surface as a 5xx, which
   * is indistinguishable from an outage, so failures only count once the prompt must be dead.
   * Default: equal to `callbackDeadlineMs`.
   */
  failureGraceMs?: number;
  /** How long a reconciler or dispatcher claim lasts. Must exceed one transport timeout. Default 60 s. */
  leaseMs?: number;
  /** How long after a failed handler before the event is delivered again. Default 30 s. */
  redeliveryDelayMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface ReconcileResult {
  /** Charges claimed past their deadline in this sweep. */
  checked: number;
  settled: number;
  failed: number;
  /** Moved to `unresolved`: out of automatic options, a person decides. */
  unresolved: number;
  /** Still in flight, or the query was unavailable and does not count yet. Retried next sweep. */
  stillWaiting: number;
  /** Safaricom's answer contradicts a charge that is already terminal. Nothing changed. */
  discrepancies: number;
  /** Charges whose processing threw (e.g. database error). Their lease expires and they retry. */
  errors: number;
}

export interface EventMeta {
  type: OutboxType;
  /** Present for `discrepancy`: what Safaricom said versus what is recorded. */
  detail: unknown;
  /** 1 on first delivery. Delivery is at-least-once, so handlers must be idempotent on `charge.id`. */
  attempt: number;
}
export type EventHandler = (charge: Charge, meta: EventMeta) => void | Promise<void>;

export interface DispatchResult {
  delivered: number;
  /** Handlers that threw. The event stays queued and is redelivered after `redeliveryDelayMs`. */
  failed: number;
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
   *
   * `olderThanMs` MUST exceed your transport's total timeout, retries included. A charge
   * is `pending` for as long as the push is in flight, so a window shorter than that
   * sweeps up live requests and churns healthy charges into `push_unknown`. That is no
   * longer destructive — a late push response is now recognised and its id retained —
   * but it is pointless work. Minutes, not seconds.
   */
  recover(opts: { olderThanMs: number }): Promise<Charge[]>;
  /**
   * The sweep. Claims charges past their callback deadline, asks Safaricom with STK Push Query,
   * and resolves each to a terminal state, or to `unresolved` when nobody can say. Safe to run
   * from several processes at once: claims are leased and every transition is a compare-and-set.
   * Run it on a timer. It dispatches any queued events when it finishes.
   */
  reconcile(opts?: { limit?: number; concurrency?: number }): Promise<ReconcileResult>;
  /**
   * Subscribe to `settled`, `failed`, `unresolved` or `discrepancy`. Events are persisted with the
   * transition that caused them and delivered at-least-once by `dispatch()`; a type with no
   * handler is left queued. Returns an unsubscribe function.
   */
  on(type: OutboxType, handler: EventHandler): () => void;
  /** Deliver queued events to handlers. Call after `res.sendStatus(200)`, and on a timer. */
  dispatch(opts?: { limit?: number }): Promise<DispatchResult>;
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

/** How many times apply() will re-read and re-decide after losing a compare-and-set. */
const MAX_CAS_ATTEMPTS = 3;

export function createReliableDaraja(opts: ReliableOptions): Reliable {
  const { transport, store } = opts;
  const now = opts.now ?? (() => new Date());
  const trusted = opts.trustedSourceIps === 'disabled' ? null : buildIpMatcher(opts.trustedSourceIps);
  const deadlineMs = opts.callbackDeadlineMs ?? 4 * 60_000;
  const graceMs = opts.failureGraceMs ?? deadlineMs;
  const leaseMs = opts.leaseMs ?? 60_000;
  const redeliveryDelayMs = opts.redeliveryDelayMs ?? 30_000;
  const handlers = new Map<OutboxType, EventHandler[]>();

  async function dispatch({ limit = 100 }: { limit?: number } = {}): Promise<DispatchResult> {
    const types = [...handlers.entries()].filter(([, h]) => h.length > 0).map(([t]) => t);
    const out: DispatchResult = { delivered: 0, failed: 0 };
    if (types.length === 0) return out; // nobody is listening: leave events queued, never consume them

    const entries = await store.claimOutbox({ types, limit, leaseMs, now: now() });
    for (const e of entries) {
      try {
        const charge = await store.get(e.chargeId);
        if (!charge) throw new Error(`outbox ${e.id}: charge ${e.chargeId} no longer exists`);
        for (const h of handlers.get(e.type) ?? []) await h(charge, { type: e.type, detail: e.payload, attempt: e.attempts });
        await store.markDelivered(e.id, now());
        out.delivered++;
      } catch {
        // Keep the event. A handler that cannot cope is redelivered, not dropped.
        await store.markDeliveryFailed(e.id, new Date(now().getTime() + redeliveryDelayMs));
        out.failed++;
      }
    }
    return out;
  }

  /** Resolve one claimed charge. Never throws for Safaricom-side failures; those are outcomes. */
  async function resolveOne(c: Charge, res: ReconcileResult): Promise<void> {
    res.checked++;

    // No CheckoutRequestID means nothing to query: the push response was lost. Guessing here
    // is exactly how double-refunds happen, so the only honest move is to hand it to a person.
    if (c.state === 'push_unknown') {
      const a = await apply(c, { type: 'deadline_passed' });
      if (a.applied) res.unresolved++;
      else res.stillWaiting++; // moved under us (e.g. a late push response gave it an id)
      return;
    }

    let answer: Awaited<ReturnType<Transport['stkQuery']>>;
    try {
      answer = await transport.stkQuery(c.checkoutRequestId!);
    } catch {
      // Could not get an answer. Whether that counts against the charge depends on its age: a
      // query made while the prompt is still live can look exactly like an outage.
      const aged = now().getTime() - c.pushStartedAt.getTime() >= deadlineMs + graceMs;
      if (!aged) {
        res.stillWaiting++;
        return;
      }
      const failures = c.queryFailures + 1;
      await store.setQueryFailures(c.id, failures);
      if (failures < QUERY_FAILURE_LIMIT) {
        res.stillWaiting++;
        return;
      }
      const a = await apply({ ...c, queryFailures: failures }, { type: 'query_failed', consecutiveFailures: failures });
      if (a.applied) res.unresolved++;
      else res.stillWaiting++;
      return;
    }

    if (answer.status === 'processing') {
      if (c.queryFailures > 0) await store.setQueryFailures(c.id, 0); // got an answer: the streak is over
      res.stillWaiting++;
      return;
    }

    const a = await apply(c, { type: 'query_result', resultCode: answer.resultCode });
    if (a.applied) {
      if (a.charge.state === 'settled') res.settled++;
      else res.failed++;
      return;
    }
    // Lost the compare-and-set and the re-read is terminal: a callback got there first. Forward-
    // only means we do not overwrite it, but if Safaricom now says something different the two
    // answers contradict and a person should know.
    if (TERMINAL.has(a.charge.state) && (answer.resultCode === 0) !== (a.charge.state === 'settled')) {
      await store.appendOutbox({
        chargeId: a.charge.id,
        type: 'discrepancy',
        payload: { source: 'reconciler', queryResultCode: answer.resultCode, recordedState: a.charge.state },
      });
      res.discrepancies++;
    } else {
      res.stillWaiting++;
    }
  }

  /**
   * Run an event through the pure machine, then compare-and-set it into the store.
   * `applied` is true only for the single caller whose CAS won.
   *
   * A CAS miss means the state MOVED, not that the event was inapplicable. `next()` was
   * decided against a view that is now stale, and the very same event is often applicable
   * to the new state: a callback landing exactly as the reconciler gives up is the common
   * case, and `next(unresolved, callback)` settles. Treating a miss as "ignore it" throws
   * away an answer Safaricom will never send again, so a miss re-reads and re-decides.
   */
  async function apply(
    c0: Charge,
    e: Event,
    patch?: { checkoutRequestId?: string; receipt?: string },
  ): Promise<{ charge: Charge; applied: boolean }> {
    const ignored = (c: Charge) =>
      store.appendAudit({
        chargeId: c.id, checkoutRequestId: c.checkoutRequestId, kind: 'ignored',
        event: e, fromState: c.state, toState: null, rawPayload: null, at: now(),
      });

    // Identity before state. The CheckoutRequestID is written on its own statement, so
    // that however the transition below turns out, the charge stays bindable to its
    // callback. A charge that keeps its id is recoverable; one that loses it is not.
    let c = c0;
    if (patch?.checkoutRequestId) {
      c = (await store.bindCheckoutRequestId(c0.id, patch.checkoutRequestId)) ?? c0;
    }

    // Bounded so a pathologically contended row cannot spin here forever.
    for (let attempt = 1; ; attempt++) {
      const to = next(c as ChargeView, e);
      if (to === null) {
        await ignored(c);
        return { charge: c, applied: false };
      }

      const updated = await store.transition(c.id, c.state, to, patch);
      if (updated) {
        await store.appendAudit({
          chargeId: c.id, checkoutRequestId: updated.checkoutRequestId, kind: 'transition',
          event: e, fromState: c.state, toState: to, rawPayload: null, at: now(),
        });
        return { charge: updated, applied: true };
      }

      const fresh = await store.get(c.id);
      if (!fresh || attempt >= MAX_CAS_ATTEMPTS) {
        await ignored(fresh ?? c);
        return { charge: fresh ?? c, applied: false };
      }
      c = fresh;
    }
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
      //    is never mistaken for a transport outcome: it propagates rather than being read
      //    as a push failure. Where that leaves the row depends on how far apply() got —
      //    still `pending`, for recover() to pick up, or already transitioned with only the
      //    audit write lost. Either way the state is never a lie about the push.
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
          await store.appendOutbox({
            chargeId: charge.id,
            type: 'discrepancy',
            payload: { source: 'callback', reason: 'receipt_already_used', receipt: cb.receipt, recordedState: charge.state },
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
        if (conflict) {
          await store.appendOutbox({
            chargeId: c.id,
            type: 'discrepancy',
            payload: { source: 'callback', callbackResultCode: cb.resultCode, recordedState: c.state },
          });
        }
        return result('already_terminal', c, { duplicate: true, conflict });
      }
      return result('not_applicable', c);
    },

    async reconcile({ limit = 100, concurrency = 5 } = {}) {
      const res: ReconcileResult = { checked: 0, settled: 0, failed: 0, unresolved: 0, stillWaiting: 0, discrepancies: 0, errors: 0 };
      let remaining = limit;

      // Claim in small batches rather than all `limit` at once: a lease then only has to cover
      // one batch (about one transport timeout), not the whole sweep. A charge that is still
      // in flight keeps its lease, so it is not re-claimed and the loop terminates.
      while (remaining > 0) {
        const batch = await store.claimOverdue({
          before: new Date(now().getTime() - deadlineMs),
          limit: Math.min(concurrency, remaining),
          leaseMs,
          now: now(),
        });
        if (batch.length === 0) break;
        remaining -= batch.length;
        await Promise.all(
          batch.map((c) =>
            resolveOne(c, res).catch(() => {
              res.errors++; // its lease expires and the next sweep retries it
            }),
          ),
        );
      }

      await dispatch().catch(() => undefined); // delivery trouble must not mask a finished sweep
      return res;
    },

    on(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
      return () => {
        const l = handlers.get(type);
        if (l) handlers.set(type, l.filter((h) => h !== handler));
      };
    },

    dispatch,

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
