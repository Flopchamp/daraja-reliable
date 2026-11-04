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

export const TERMINAL: ReadonlySet<State> = new Set<State>(['settled', 'failed']);
export const QUERY_FAILURE_LIMIT = 3;

/** Monotonic rank; a transition may never lower it. */
export const RANK: Readonly<Record<State, number>> = {
  pending: 0,
  push_unknown: 1,
  awaiting_callback: 1,
  unresolved: 2,
  settled: 3,
  failed: 3,
};

/** Next state, or null when the event must not change state (record for audit only). */
export function next(state: State, e: Event): State | null {
  if (TERMINAL.has(state)) return null;

  switch (e.type) {
    case 'push_accepted':
      return state === 'pending' ? 'awaiting_callback' : null;
    case 'push_rejected':
      return state === 'pending' ? 'failed' : null;
    case 'push_ambiguous':
      return state === 'pending' ? 'push_unknown' : null;

    case 'callback':
      return state === 'awaiting_callback' || state === 'unresolved'
        ? e.resultCode === 0
          ? 'settled'
          : 'failed'
        : null;

    case 'query_result':
      if (state !== 'awaiting_callback' || e.resultCode === 'processing') return null;
      return e.resultCode === 0 ? 'settled' : 'failed';

    case 'query_failed':
      return state === 'awaiting_callback' && e.consecutiveFailures >= QUERY_FAILURE_LIMIT
        ? 'unresolved'
        : null;

    case 'deadline_passed':
      return state === 'push_unknown' ? 'unresolved' : null;

    case 'manual_resolve':
      return state === 'unresolved' ? e.to : null;
  }
}
