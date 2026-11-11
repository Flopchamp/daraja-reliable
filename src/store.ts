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
  attempt: number;
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
}

export interface AuditEntry {
  chargeId: string | null;
  checkoutRequestId: string | null;
  kind: 'transition' | 'ignored' | 'callback_raw' | 'untrusted_source' | 'malformed';
  event: Event | null;
  fromState: State | null;
  toState: State | null;
  rawPayload: string | null;
  at: Date;
}

/**
 * Persistence contract. Every state change is a compare-and-set on (id, expected state):
 * the implementation MUST be a single atomic statement, never read-then-write.
 */
export interface Store {
  /** Insert the intent row, or return the existing one for this key. `created` says which. */
  insertIntent(c: NewCharge): Promise<{ charge: Charge; created: boolean }>;

  get(id: string): Promise<Charge | null>;
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

  /** Atomically move `id` from `from` to `to`; returns the updated charge or null if state differed. */
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

  appendAudit(entry: AuditEntry): Promise<void>;
}
