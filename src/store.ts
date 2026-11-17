import type { Event, State } from './state.js';

export interface Charge {
  id: string;
  idempotencyKey: string;
  /** sha256(phone|amount|accountRef); same key + different fingerprint is a conflict. */
  fingerprint: string;
  phone: string;
  amount: number;
  accountRef: string;
  state: State;
  checkoutRequestId: string | null;
  /** M-Pesa receipt; set only when settled by a callback that carried one. */
  receipt: string | null;
  /** 1 for an ordinary charge; each `chargeAgain()` in a chain adds one. */
  attempt: number;
  /**
   * The first charge of a retry chain, or null for a charge that was never retried and is not
   * itself a retry. `rootId ?? id` identifies one logical payment: key fulfilment on that, not
   * on `id`, or a payment that was prompted twice and paid once could be fulfilled twice.
   */
  rootId: string | null;
  queryFailures: number;
  pushStartedAt: Date;
  /** Reconciler lease; null when not claimed. */
  claimedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewCharge {
  idempotencyKey: string;
  fingerprint: string;
  phone: string;
  amount: number;
  accountRef: string;
  /** Set only by `chargeAgain()`. */
  rootId?: string;
  attempt?: number;
}

export interface AuditEntry {
  chargeId: string | null;
  checkoutRequestId: string | null;
  kind: 'transition' | 'ignored' | 'callback_raw' | 'untrusted_source' | 'malformed' | 'retry';
  event: Event | null;
  fromState: State | null;
  toState: State | null;
  rawPayload: string | null;
  at: Date;
}

/**
 * What the application is told about. `settled`, `failed` and `unresolved` are written by the
 * store itself, atomically with the transition that causes them. `discrepancy` means Safaricom's
 * evidence contradicts a charge already recorded as terminal; nothing changed, a person should look.
 */
export type OutboxType = 'settled' | 'failed' | 'unresolved' | 'discrepancy';

export interface OutboxEntry {
  /** bigserial, so a string: it can exceed Number.MAX_SAFE_INTEGER in principle. */
  id: string;
  chargeId: string;
  type: OutboxType;
  payload: unknown;
  /** Delivery attempts so far, including the one this claim represents. */
  attempts: number;
}

/**
 * Persistence contract. Every state change is a compare-and-set on (id, expected state):
 * the implementation MUST be a single atomic statement, never read-then-write.
 */
export interface Store {
  /** Insert the intent row, or return the existing one for this key. `created` says which. */
  insertIntent(c: NewCharge): Promise<{ charge: Charge; created: boolean }>;

  get(id: string): Promise<Charge | null>;
  /** Read-only: the charge holding this idempotency key, or null. Never creates anything. */
  getByIdempotencyKey(key: string): Promise<Charge | null>;
  getByCheckoutRequestId(checkoutRequestId: string): Promise<Charge | null>;

  /**
   * Record the CheckoutRequestID, which is IDENTITY rather than state: it is the only
   * correlation id Safaricom ever issues, it exists solely in the push response, and
   * without it no callback or query can ever be bound to this charge.
   *
   * It is therefore persisted on its own, never as a passenger on a state transition that
   * might lose a compare-and-set race — losing that race must not be able to discard it.
   * Idempotent and state-independent: first write wins, later writes are no-ops, and the
   * current charge comes back either way.
   */
  bindCheckoutRequestId(id: string, checkoutRequestId: string): Promise<Charge | null>;

  /**
   * Atomically move `id` from `from` to `to`; returns the updated charge or null if state differed.
   *
   * When `to` is settled, failed or unresolved the matching outbox row MUST be inserted by the
   * same atomic statement: the event exists if and only if the transition committed. A compare-
   * and-set that loses writes no event, which is what makes delivery exactly-once per transition.
   */
  transition(
    id: string,
    from: State,
    to: State,
    patch?: { checkoutRequestId?: string; queryFailures?: number; receipt?: string },
  ): Promise<Charge | null>;

  /** Claim up to `limit` overdue charges for `leaseMs`; claimed rows are invisible to other claimers. */
  claimOverdue(opts: { before: Date; limit: number; leaseMs: number; now: Date }): Promise<Charge[]>;

  /** Release a lease early. */
  release(id: string): Promise<void>;

  /**
   * Crash recovery: charges still `pending` since before `before` had their push response
   * lost (the process died between the intent write and storing the outcome). Moves them
   * to `push_unknown` in one statement and returns them. Never re-pushes.
   */
  markStalePending(before: Date): Promise<Charge[]>;

  /**
   * Record a consecutive query-failure count WITHOUT changing state and WITHOUT releasing the
   * lease, so the lease keeps acting as backoff until it expires.
   */
  setQueryFailures(id: string, count: number): Promise<void>;

  appendAudit(entry: AuditEntry): Promise<void>;

  /** Append an event that no transition produces (a `discrepancy`). */
  appendOutbox(e: { chargeId: string; type: OutboxType; payload: unknown }): Promise<void>;

  /**
   * Claim up to `limit` undelivered events of the given types for `leaseMs`, oldest first. A
   * claimed row is invisible to other claimers until the lease expires, and each claim counts
   * as an attempt. Only the requested types are claimed, so an event nobody listens for stays
   * queued instead of being consumed and lost.
   */
  claimOutbox(opts: { types: readonly OutboxType[]; limit: number; leaseMs: number; now: Date }): Promise<OutboxEntry[]>;

  /**
   * Other charges of the same retry chain as `id` that are already `settled`. Empty for a charge
   * that was never retried. Used after a settlement commits, to notice a payment that was
   * prompted twice and paid twice.
   */
  settledInChain(id: string): Promise<Charge[]>;

  markDelivered(id: string, at: Date): Promise<void>;

  /** Delivery failed: keep the event, and make it claimable again at `retryAt`. */
  markDeliveryFailed(id: string, retryAt: Date): Promise<void>;
}
