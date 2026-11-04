import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { next, RANK, TERMINAL, type Event, type State } from '../../src/state.js';

const states: State[] = ['pending', 'push_unknown', 'awaiting_callback', 'unresolved', 'settled', 'failed'];

const eventArb: fc.Arbitrary<Event> = fc.oneof(
  fc.string({ minLength: 1 }).map((id): Event => ({ type: 'push_accepted', checkoutRequestId: id })),
  fc.constant<Event>({ type: 'push_rejected', reason: 'x' }),
  fc.constant<Event>({ type: 'push_ambiguous' }),
  fc.integer({ min: 0, max: 3000 }).map((c): Event => ({ type: 'callback', resultCode: c })),
  fc
    .oneof(fc.integer({ min: 0, max: 3000 }), fc.constant('processing' as const))
    .map((c): Event => ({ type: 'query_result', resultCode: c })),
  fc.nat(10).map((n): Event => ({ type: 'query_failed', consecutiveFailures: n })),
  fc.constant<Event>({ type: 'deadline_passed' }),
  fc.constantFrom<'settled' | 'failed'>('settled', 'failed').map((to): Event => ({ type: 'manual_resolve', to })),
);

describe('state machine properties', () => {
  it('1. terminal states never change', () => {
    fc.assert(
      fc.property(fc.constantFrom<State>('settled', 'failed'), eventArb, (s, e) => next(s, e) === null),
    );
  });

  it('2. rank never decreases along any event sequence', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 40 }), (events) => {
        let s: State = 'pending';
        for (const e of events) {
          const n = next(s, e);
          if (n !== null) {
            expect(RANK[n]).toBeGreaterThanOrEqual(RANK[s]);
            s = n;
          }
        }
      }),
    );
  });

  it('3. push_unknown is never auto-resolved to a terminal state', () => {
    const automatic = eventArb.filter((e) => e.type !== 'manual_resolve');
    fc.assert(
      fc.property(automatic, (e) => {
        const n = next('push_unknown', e);
        return n === null || n === 'unresolved';
      }),
    );
  });

  it('4. a second push_accepted never changes state', () => {
    for (const s of states.filter((x) => x !== 'pending')) {
      expect(next(s, { type: 'push_accepted', checkoutRequestId: 'a' })).toBeNull();
    }
  });

  it('only pending can be moved by push outcomes', () => {
    for (const s of states.filter((x) => x !== 'pending')) {
      expect(next(s, { type: 'push_ambiguous' })).toBeNull();
      expect(next(s, { type: 'push_rejected', reason: '' })).toBeNull();
    }
  });
});

describe('state machine examples', () => {
  it('happy path', () => {
    expect(next('pending', { type: 'push_accepted', checkoutRequestId: 'a' })).toBe('awaiting_callback');
    expect(next('awaiting_callback', { type: 'callback', resultCode: 0 })).toBe('settled');
  });

  it('non-zero callback fails the charge', () => {
    expect(next('awaiting_callback', { type: 'callback', resultCode: 1032 })).toBe('failed');
  });

  it('late failure callback on a settled charge is ignored', () => {
    expect(next('settled', { type: 'callback', resultCode: 1032 })).toBeNull();
  });

  it('"processing" query result leaves state alone', () => {
    expect(next('awaiting_callback', { type: 'query_result', resultCode: 'processing' })).toBeNull();
  });

  it('three query failures make a charge unresolved, two do not', () => {
    expect(next('awaiting_callback', { type: 'query_failed', consecutiveFailures: 2 })).toBeNull();
    expect(next('awaiting_callback', { type: 'query_failed', consecutiveFailures: 3 })).toBe('unresolved');
  });

  it('unresolved can be resolved by a real callback or manually', () => {
    expect(next('unresolved', { type: 'callback', resultCode: 0 })).toBe('settled');
    expect(next('unresolved', { type: 'manual_resolve', to: 'failed' })).toBe('failed');
  });

  it('TERMINAL is exactly settled and failed', () => {
    expect([...TERMINAL].sort()).toEqual(['failed', 'settled']);
  });
});
