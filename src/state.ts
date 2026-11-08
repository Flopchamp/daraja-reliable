export type State =
  | 'pending'
  | 'push_unknown'
  | 'awaiting_callback'
  | 'unresolved'
  | 'settled'
  | 'failed';

export type Event =
  | { type: 'push_accepted'; checkoutRequestId: string }
  | { type: 'push_rejected'; reason: string }
  | { type: 'push_ambiguous' }
  | { type: 'callback'; resultCode: number }
  | { type: 'query_result'; resultCode: number | 'processing' }
  | { type: 'query_failed'; consecutiveFailures: number }
  | { type: 'deadline_passed' }
  | { type: 'manual_resolve'; to: 'settled' | 'failed' };

/**
 * The part of a charge the transition rules depend on. `Charge` satisfies this
 * structurally, so callers pass the row itself.
 */
export interface ChargeView {
  state: State;
  checkoutRequestId: string | null;
}

export const TERMINAL: ReadonlySet<State> = new Set<State>(['settled', 'failed']);
export const QUERY_FAILURE_LIMIT = 3;

/**
 * Events that are Safaricom's evidence about one specific charge.
 *
 * STK Push takes no caller-supplied correlation id: `CheckoutRequestID` exists
 * only in the push response. A charge that lost that response therefore has
 * nothing for a callback or a query to bind to, and matching one on
 * (phone, amount, accountRef) is a heuristic rather than proof — two customers
 * can pay the same amount against the same reference in the same minute. So
 * these events must not move a charge we cannot identify, however suggestive
 * the payload looks. Such a charge is resolvable only by a human.
 */
const NEEDS_CHECKOUT_ID: ReadonlySet<Event['type']> = new Set<Event['type']>([
  'callback',
  'query_result',
  'query_failed',
]);

/**
 * Every legal transition, as `from->to`. The property tests assert that no
 * event sequence produces an edge outside this set, which is strictly stronger
 * than checking a monotonic rank: `push_unknown` and `awaiting_callback` are
 * parallel branches rather than successive stages, so no rank can order them
 * and a rank that ties them permits illegal sideways moves between the two.
 */
export const ALLOWED_EDGES: ReadonlySet<string> = new Set<string>([
  'pending->awaiting_callback',
  'pending->failed',
  'pending->push_unknown',
  'awaiting_callback->settled',
  'awaiting_callback->failed',
  'awaiting_callback->unresolved',
  'push_unknown->unresolved',
  'unresolved->settled',
  'unresolved->failed',
]);

/** Next state, or null when the event must not change state (record for audit only). */
export function next(c: ChargeView, e: Event): State | null {
  if (TERMINAL.has(c.state)) return null;
  if (c.checkoutRequestId === null && NEEDS_CHECKOUT_ID.has(e.type)) return null;

  switch (e.type) {
    case 'push_accepted':
      return c.state === 'pending' ? 'awaiting_callback' : null;
    case 'push_rejected':
      return c.state === 'pending' ? 'failed' : null;
    case 'push_ambiguous':
      return c.state === 'pending' ? 'push_unknown' : null;

    case 'callback':
      return c.state === 'awaiting_callback' || c.state === 'unresolved'
        ? e.resultCode === 0
          ? 'settled'
          : 'failed'
        : null;

    case 'query_result':
      if (c.state !== 'awaiting_callback' || e.resultCode === 'processing') return null;
      return e.resultCode === 0 ? 'settled' : 'failed';

    case 'query_failed':
      return c.state === 'awaiting_callback' && e.consecutiveFailures >= QUERY_FAILURE_LIMIT
        ? 'unresolved'
        : null;

    case 'deadline_passed':
      return c.state === 'push_unknown' ? 'unresolved' : null;

    case 'manual_resolve':
      return c.state === 'unresolved' ? e.to : null;
  }
}
