import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createReliableDaraja, fingerprint } from '../../src/reliable.js';
import type { PostgresStore } from '../../src/pg-store.js';
import type { Store } from '../../src/store.js';
import { FakeDaraja } from '../../src/testing/fake-daraja.js';
import { freshDb, req } from './helpers.js';

let pool: pg.Pool;
let store: PostgresStore;
let fake: FakeDaraja;

beforeEach(async () => {
  ({ pool, store } = await freshDb());
  fake = new FakeDaraja();
});
afterAll(async () => {
  await pool?.end();
});

const make = (s: Store, now?: () => Date) =>
  createReliableDaraja({ transport: fake, store: s, trustedSourceIps: 'disabled', ...(now ? { now } : {}) });

const SAFARICOM_IP = '196.201.214.200';

/**
 * A store that slips one concurrent transition in between apply()'s read and its
 * compare-and-set, so the CAS deliberately misses. This is the race that used to
 * silently discard Safaricom's answer; it is forced here rather than waited for.
 */
function racing(real: Store, hook: () => Promise<unknown>): Store {
  let fired = false;
  return {
    insertIntent: (c) => real.insertIntent(c),
    get: (id) => real.get(id),
    getByCheckoutRequestId: (x) => real.getByCheckoutRequestId(x),
    bindCheckoutRequestId: (id, x) => real.bindCheckoutRequestId(id, x),
    claimOverdue: (o) => real.claimOverdue(o),
    release: (id) => real.release(id),
    markStalePending: (d) => real.markStalePending(d),
    appendAudit: (e) => real.appendAudit(e),
    async transition(id, from, to, patch) {
      if (!fired) {
        fired = true;
        await hook();
      }
      return real.transition(id, from, to, patch);
    },
  };
}

const transitions = async (chargeId: string) =>
  (
    await pool.query(
      "SELECT from_state, to_state FROM dr_audit WHERE charge_id = $1 AND kind = 'transition' ORDER BY id",
      [chargeId],
    )
  ).rows;

describe('regression: recover() sweeping a push that is still in flight', () => {
  it('keeps the CheckoutRequestID of a successful push, and the charge still settles', async () => {
    fake.latencyMs = 400; // the push is slow enough for the sweep to overtake it
    const pesa = make(store);

    const inFlight = pesa.charge({ idempotencyKey: 'racy', ...req });
    await new Promise((r) => setTimeout(r, 60)); // intent committed, push in flight

    // A sweep with a window shorter than the push latency: exactly the misconfiguration
    // that used to lose the payment. It writes the live charge off as push_unknown.
    const moved = await make(store, () => new Date(Date.now() + 120_000)).recover({ olderThanMs: 60_000 });
    expect(moved).toHaveLength(1);

    const r = await inFlight;
    const realId = [...fake.registered.keys()][0]!;

    // The id is retained even though the transition it rode in on lost its race,
    // and the late push response is recognised rather than dropped.
    expect(r.checkoutRequestId).toBe(realId);
    expect(r.state).toBe('awaiting_callback');
    expect(await transitions(r.id)).toEqual([
      { from_state: 'pending', to_state: 'push_unknown' },
      { from_state: 'push_unknown', to_state: 'awaiting_callback' },
    ]);

    // And the customer's payment binds to the charge it belongs to.
    const cb = await pesa.handleCallback({ rawBody: fake.callbackBody(realId), sourceIp: SAFARICOM_IP });
    expect(cb.applied).toBe(true);
    expect((await store.get(r.id))?.state).toBe('settled');
  });
});

describe('regression: a push response that arrives after a human already owns the charge', () => {
  it('records the id without moving the charge, so a later callback can still settle it', async () => {
    fake.latencyMs = 400;
    const pesa = make(store);

    const inFlight = pesa.charge({ idempotencyKey: 'verylate', ...req });
    await new Promise((r) => setTimeout(r, 60));

    // The sweep writes the live charge off, then its deadline passes: it is now in
    // `unresolved`, which means a person is expected to look at it.
    const [stale] = await make(store, () => new Date(Date.now() + 120_000)).recover({ olderThanMs: 60_000 });
    await store.transition(stale!.id, 'push_unknown', 'unresolved');

    const r = await inFlight;
    const realId = [...fake.registered.keys()][0]!;

    // apply() does NOT drag the charge back out of the human's queue...
    expect(r.state).toBe('unresolved');
    // ...but it still records the identity, which is the whole point of writing it
    // separately from the transition. Without this the id would be lost for good,
    // because no transition was taken to carry it.
    expect(r.checkoutRequestId).toBe(realId);

    // So when the customer's payment confirms, it binds and resolves itself.
    const cb = await pesa.handleCallback({ rawBody: fake.callbackBody(realId), sourceIp: SAFARICOM_IP });
    expect(cb.applied).toBe(true);
    expect((await store.get(r.id))?.state).toBe('settled');
  });
});

describe('regression: a callback landing exactly as the reconciler gives up', () => {
  it('is applied against the fresh state instead of being discarded', async () => {
    const r = await make(store).charge({ idempotencyKey: 'late', ...req });
    expect(r.state).toBe('awaiting_callback');
    const crid = r.checkoutRequestId!;

    // The callback is in flight. Meanwhile the reconciler exhausts its query budget and
    // moves the charge awaiting_callback -> unresolved, so the callback's CAS misses.
    const s = racing(store, () => store.transition(r.id, 'awaiting_callback', 'unresolved'));

    const cb = await make(s).handleCallback({
      rawBody: fake.callbackBody(crid, { resultCode: 0 }),
      sourceIp: SAFARICOM_IP,
    });

    // next(unresolved, callback 0) === 'settled', so this WAS applicable all along.
    expect(cb).toMatchObject({ applied: true, duplicate: false, conflict: false, reason: 'applied' });
    const after = await store.get(r.id);
    expect(after?.state).toBe('settled');
    expect(after?.receipt).not.toBeNull();

    // The winning transition was decided against the state the row actually had.
    expect((await transitions(r.id)).at(-1)).toMatchObject({
      from_state: 'unresolved',
      to_state: 'settled',
    });
  });

  it('a retry still credits exactly once when the row has already gone terminal', async () => {
    const r = await make(store).charge({ idempotencyKey: 'done-already', ...req });
    const crid = r.checkoutRequestId!;

    // The reconciler settled it from a query a moment before the callback arrived.
    const s = racing(store, () => store.transition(r.id, 'awaiting_callback', 'settled'));

    const cb = await make(s).handleCallback({
      rawBody: fake.callbackBody(crid, { resultCode: 0 }),
      sourceIp: SAFARICOM_IP,
    });

    expect(cb).toMatchObject({ applied: false, duplicate: true, reason: 'already_terminal' });
    expect((await store.get(r.id))?.state).toBe('settled');

    // The hook settled the row behind apply()'s back, so the only transition the library
    // itself recorded is the original push: retrying did NOT settle it a second time.
    expect(await transitions(r.id)).toEqual([{ from_state: 'pending', to_state: 'awaiting_callback' }]);
  });
});

describe('bindCheckoutRequestId: identity is written independently of state', () => {
  it('is idempotent, never overwrites, and does not move the charge', async () => {
    const { charge } = await store.insertIntent({
      idempotencyKey: 'bind',
      fingerprint: fingerprint(req),
      ...req,
    });

    expect((await store.bindCheckoutRequestId(charge.id, 'ws_A'))?.checkoutRequestId).toBe('ws_A');
    // A second, different id does not clobber the first: one push, one id, first write wins.
    expect((await store.bindCheckoutRequestId(charge.id, 'ws_B'))?.checkoutRequestId).toBe('ws_A');
    expect((await store.get(charge.id))?.state).toBe('pending'); // identity is not state
  });
});
