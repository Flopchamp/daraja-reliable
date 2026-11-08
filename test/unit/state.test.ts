import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ALLOWED_EDGES,
  next,
  TERMINAL,
  type ChargeView,
  type Event,
  type State,
} from '../../src/state.js';

const states: State[] = ['pending', 'push_unknown', 'awaiting_callback', 'unresolved', 'settled', 'failed'];

/** A charge whose push response came back, so Safaricom's evidence can bind to it. */
const withId = (state: State): ChargeView => ({ state, checkoutRequestId: 'ws_CO_000000000001' });
/** A charge whose push response was lost, so nothing identifies it. */
const noId = (state: State): ChargeView => ({ state, checkoutRequestId: null });

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

const idArb = fc.oneof(fc.constant(null), fc.string({ minLength: 1 }));

const chargeArb: fc.Arbitrary<ChargeView> = fc.record({
  state: fc.constantFrom(...states),
  checkoutRequestId: idArb,
});

describe('state machine properties', () => {
  it('1. terminal states never change, with or without an id', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<State>('settled', 'failed'),
        idArb,
        eventArb,
        (state, checkoutRequestId, e) => next({ state, checkoutRequestId }, e) === null,
      ),
    );
  });

  it('2. every transition taken is in ALLOWED_EDGES', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 40 }), (events) => {
        // Walk from a fresh intent row. The id appears only when a push is accepted,
        // which is what makes the two routes into `unresolved` behave differently.
        let c: ChargeView = { state: 'pending', checkoutRequestId: null };
        for (const e of events) {
          const n = next(c, e);
          if (n === null) continue;
          expect(ALLOWED_EDGES.has(`${c.state}->${n}`)).toBe(true);
          c = {
            state: n,
            checkoutRequestId:
              e.type === 'push_accepted' ? e.checkoutRequestId : c.checkoutRequestId,
          };
        }
      }),
    );
  });

  it('3. a charge with no CheckoutRequestID never reaches a terminal state automatically', () => {
    // `pending` is excluded deliberately: a push Safaricom definitively refused
    // goes straight to `failed` and needs no id, because nothing was queued.
    const automatic = eventArb.filter((e) => e.type !== 'manual_resolve');
    fc.assert(
      fc.property(fc.constantFrom<State>('push_unknown', 'unresolved'), automatic, (state, e) => {
        const n = next(noId(state), e);
        return n === null || !TERMINAL.has(n);
      }),
    );
  });

  it('4. a second push_accepted never changes state', () => {
    fc.assert(
      fc.property(chargeArb, fc.string({ minLength: 1 }), (c, id) => {
        if (c.state === 'pending') return true;
        return next(c, { type: 'push_accepted', checkoutRequestId: id }) === null;
      }),
    );
  });

  it("5. Safaricom's evidence cannot move a charge we cannot identify", () => {
    const evidence = eventArb.filter(
      (e) => e.type === 'callback' || e.type === 'query_result' || e.type === 'query_failed',
    );
    fc.assert(
      fc.property(fc.constantFrom(...states), evidence, (state, e) => next(noId(state), e) === null),
    );
  });

  it('only pending can be moved by push outcomes', () => {
    for (const s of states.filter((x) => x !== 'pending')) {
      expect(next(withId(s), { type: 'push_ambiguous' })).toBeNull();
      expect(next(withId(s), { type: 'push_rejected', reason: '' })).toBeNull();
      expect(next(noId(s), { type: 'push_ambiguous' })).toBeNull();
      expect(next(noId(s), { type: 'push_rejected', reason: '' })).toBeNull();
    }
  });
});

describe('state machine examples', () => {
  it('happy path', () => {
    expect(next(noId('pending'), { type: 'push_accepted', checkoutRequestId: 'a' })).toBe('awaiting_callback');
    expect(next(withId('awaiting_callback'), { type: 'callback', resultCode: 0 })).toBe('settled');
  });

  it('non-zero callback fails the charge', () => {
    expect(next(withId('awaiting_callback'), { type: 'callback', resultCode: 1032 })).toBe('failed');
  });

  it('late failure callback on a settled charge is ignored', () => {
    expect(next(withId('settled'), { type: 'callback', resultCode: 1032 })).toBeNull();
  });

  it('a lost push response gives push_unknown, and the deadline only makes it unresolved', () => {
    expect(next(noId('pending'), { type: 'push_ambiguous' })).toBe('push_unknown');
    expect(next(noId('push_unknown'), { type: 'deadline_passed' })).toBe('unresolved');
  });

  it('"processing" query result leaves state alone', () => {
    expect(next(withId('awaiting_callback'), { type: 'query_result', resultCode: 'processing' })).toBeNull();
  });

  it('three query failures make a charge unresolved, two do not', () => {
    expect(next(withId('awaiting_callback'), { type: 'query_failed', consecutiveFailures: 2 })).toBeNull();
    expect(next(withId('awaiting_callback'), { type: 'query_failed', consecutiveFailures: 3 })).toBe('unresolved');
  });

  it('unresolved settles on a real callback ONLY when we hold the id it was delivered against', () => {
    // Reached unresolved from awaiting_callback: the id is stored, so a late
    // callback is genuine evidence from Safaricom and may resolve the charge.
    expect(next(withId('unresolved'), { type: 'callback', resultCode: 0 })).toBe('settled');

    // Reached unresolved from push_unknown: no id was ever stored, so no payload
    // can honestly bind here. Settling on a (phone, amount, ref) match would
    // credit money against a payment nobody confirmed.
    expect(next(noId('unresolved'), { type: 'callback', resultCode: 0 })).toBeNull();
  });

  it('an unidentified charge is resolvable only by a human', () => {
    expect(next(noId('unresolved'), { type: 'callback', resultCode: 0 })).toBeNull();
    expect(next(noId('unresolved'), { type: 'query_result', resultCode: 0 })).toBeNull();
    expect(next(noId('unresolved'), { type: 'manual_resolve', to: 'failed' })).toBe('failed');
    expect(next(noId('unresolved'), { type: 'manual_resolve', to: 'settled' })).toBe('settled');
  });

  it('TERMINAL is exactly settled and failed', () => {
    expect([...TERMINAL].sort()).toEqual(['failed', 'settled']);
  });

  it('ALLOWED_EDGES contains no edge out of a terminal state', () => {
    for (const edge of ALLOWED_EDGES) {
      const from = edge.split('->')[0] as State;
      expect(TERMINAL.has(from)).toBe(false);
    }
  });
});
