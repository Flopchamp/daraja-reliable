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

  /** Atomically move `id` from `from` to `to`; returns the updated charge or null if state differed. */
  transition(
    id: string,
    from: State,
    to: State,
    patch?: { checkoutRequestId?: string; queryFailures?: number },
  ): Promise<Charge | null>;

  /** Claim up to `limit` overdue charges for `leaseMs`; claimed rows are invisible to other claimers. */
  claimOverdue(opts: { before: Date; limit: number; leaseMs: number; now: Date }): Promise<Charge[]>;

  /** Release a lease early. */
  release(id: string): Promise<void>;

  appendAudit(entry: AuditEntry): Promise<void>;
}
