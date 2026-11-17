import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createReliableDaraja, type EventMeta, type Reliable, type ReliableOptions } from '../../src/reliable.js';
import type { PostgresStore } from '../../src/pg-store.js';
import type { Charge, Store } from '../../src/store.js';
import { FakeDaraja } from '../../src/testing/fake-daraja.js';
import { freshDb, req } from './helpers.js';

const DEADLINE = 240_000; // the default callbackDeadlineMs
const LEASE = 60_000; // the default leaseMs
// `push_started_at` is stamped by the DATABASE's clock, but virtual time is built on this
// process's clock. If the two disagree (a Postgres in a VM that drifted, say) a charge is not
// yet overdue and a sweep sees nothing. This margin must exceed any plausible disagreement;
// it is far below the 240 s grace window, so no test that needs "not yet aged" is affected.
const CLOCK_SKEW_MARGIN = 15_000;
const PAST_DEADLINE = DEADLINE + CLOCK_SKEW_MARGIN; // overdue, but younger than deadline + grace
const PAST_GRACE = 2 * DEADLINE + CLOCK_SKEW_MARGIN; // old enough for failed queries to count
const SAFARICOM = '196.201.214.200';

let pool: pg.Pool;
let store: PostgresStore;
let fake: FakeDaraja;
let offset = 0; // virtual time, added to the real clock
const clock = () => new Date(Date.now() + offset);
const advance = (ms: number) => void (offset += ms);

beforeEach(async () => {
  ({ pool, store } = await freshDb());
  fake = new FakeDaraja();
  offset = 0;
});
afterAll(async () => {
  await pool?.end();
});

const make = (extra: Partial<ReliableOptions> = {}, s: Store = store): Reliable =>
  createReliableDaraja({ transport: fake, store: s, trustedSourceIps: [SAFARICOM], now: clock, ...extra });

const charge = (pesa: Reliable, k = 'inv-1') => pesa.charge({ idempotencyKey: k, ...req });
const stateOf = async (id: string) => (await store.get(id))?.state;
const outbox = async (type?: string) =>
  (await pool.query(`SELECT * FROM dr_outbox ${type ? 'WHERE type = $1' : ''} ORDER BY id`, type ? [type] : [])).rows;

describe('reconcile(): resolving a callback that never arrived', () => {
  it('settles it within one sweep, and only once the deadline has passed', async () => {
    const pesa = make();
    const c = await charge(pesa);

    expect(await pesa.reconcile()).toMatchObject({ checked: 0 }); // not overdue: not even queried
    expect(fake.queryCalls).toHaveLength(0);

    advance(PAST_DEADLINE);
    const r = await pesa.reconcile();
    expect(r).toMatchObject({ checked: 1, settled: 1, failed: 0, unresolved: 0, errors: 0 });
    expect(await stateOf(c.id)).toBe('settled');
    expect(fake.queryCalls).toEqual([c.checkoutRequestId]);

    expect(await pesa.reconcile()).toMatchObject({ checked: 0 }); // terminal rows are never swept again
  });

  it('a failing verdict from Safaricom fails the charge', async () => {
    const pesa = make();
    const c = await charge(pesa);
    fake.scriptQuery(c.checkoutRequestId!, { kind: 'done', resultCode: 1032 });
    advance(PAST_DEADLINE);
    expect(await pesa.reconcile()).toMatchObject({ failed: 1, settled: 0 });
    expect(await stateOf(c.id)).toBe('failed');
  });

  it('"still processing" changes nothing, counts nothing against the charge, and the lease backs off', async () => {
    const pesa = make();
    const c = await charge(pesa);
    fake.scriptQuery(c.checkoutRequestId!, { kind: 'processing' });
    advance(PAST_DEADLINE);

    expect(await pesa.reconcile()).toMatchObject({ checked: 1, stillWaiting: 1 });
    expect(await stateOf(c.id)).toBe('awaiting_callback');
    expect((await store.get(c.id))?.queryFailures).toBe(0);

    await pesa.reconcile(); // immediately again: the lease holds, so Safaricom is not hammered
    expect(fake.queryCalls).toHaveLength(1);

    advance(LEASE + 1000); // lease expired; the default answer is now "done, success"
    expect(await pesa.reconcile()).toMatchObject({ settled: 1 });
  });

  it('only charges past their deadline are touched', async () => {
    const pesa = make();
    const old = await charge(pesa, 'old');
    advance(PAST_DEADLINE);
    const fresh = await charge(pesa, 'fresh'); // pushed "now", in virtual time
    // `push_started_at` is stamped by the database at real time, so age the first one only.
    await pool.query("UPDATE dr_charges SET push_started_at = now() + interval '10 minutes' WHERE id = $1", [fresh.id]);
    expect(await pesa.reconcile()).toMatchObject({ checked: 1, settled: 1 });
    expect(await stateOf(old.id)).toBe('settled');
    expect(await stateOf(fresh.id)).toBe('awaiting_callback');
  });
});

describe('reconcile(): Safaricom cannot say', () => {
  const errorsFor = (id: string, n: number) =>
    fake.scriptQuery(id, ...Array.from({ length: n }, () => ({ kind: 'error' as const })));

  it('failed queries inside the grace window are NOT counted: an in-flight prompt can look like an outage', async () => {
    const pesa = make();
    const c = await charge(pesa);
    errorsFor(c.checkoutRequestId!, 3);
    advance(PAST_DEADLINE); // past the deadline, but younger than deadline + grace

    for (let i = 0; i < 3; i++) {
      expect(await pesa.reconcile()).toMatchObject({ stillWaiting: 1, unresolved: 0 });
      advance(LEASE + 1000);
    }
    expect(fake.queryCalls).toHaveLength(3);
    expect(await stateOf(c.id)).toBe('awaiting_callback'); // not "unresolved", and not "failed"
    expect((await store.get(c.id))?.queryFailures).toBe(0);
  });

  it('three consecutive failures after the grace window make it unresolved, never failed', async () => {
    const pesa = make();
    const c = await charge(pesa);
    errorsFor(c.checkoutRequestId!, 3);
    advance(PAST_GRACE);

    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      await pesa.reconcile();
      counts.push((await store.get(c.id))!.queryFailures);
      advance(LEASE + 1000);
    }
    expect(counts).toEqual([1, 2, 3]);
    expect(await stateOf(c.id)).toBe('unresolved');
    expect(await outbox('unresolved')).toHaveLength(1);
  });

  it('a successful answer in the middle resets the streak', async () => {
    const pesa = make();
    const c = await charge(pesa);
    fake.scriptQuery(c.checkoutRequestId!, { kind: 'error' }, { kind: 'error' }, { kind: 'processing' }, { kind: 'error' });
    advance(PAST_GRACE);

    for (let i = 0; i < 4; i++) {
      await pesa.reconcile();
      advance(LEASE + 1000);
    }
    expect(await stateOf(c.id)).toBe('awaiting_callback');
    expect((await store.get(c.id))?.queryFailures).toBe(1); // 2 errors, reset by "processing", then 1
  });

  it('an unresolved charge that holds its id is still settled by a late real callback', async () => {
    const pesa = make();
    const c = await charge(pesa);
    errorsFor(c.checkoutRequestId!, 3);
    advance(PAST_GRACE);
    for (let i = 0; i < 3; i++) {
      await pesa.reconcile();
      advance(LEASE + 1000);
    }
    expect(await stateOf(c.id)).toBe('unresolved');

    const r = await pesa.handleCallback({ rawBody: fake.callbackBody(c.checkoutRequestId!), sourceIp: SAFARICOM });
    expect(r.applied).toBe(true);
    expect(await stateOf(c.id)).toBe('settled');
  });

  it('a push whose response was lost has no id to query: unresolved, with zero queries made', async () => {
    fake.scriptPush('http500');
    const pesa = make();
    const c = await charge(pesa);
    expect(c.state).toBe('push_unknown');

    advance(PAST_DEADLINE);
    expect(await pesa.reconcile()).toMatchObject({ checked: 1, unresolved: 1 });
    expect(await stateOf(c.id)).toBe('unresolved');
    expect(fake.queryCalls).toHaveLength(0);
    expect(await outbox('unresolved')).toHaveLength(1);
  });
});

describe('reconcile(): concurrency', () => {
  it('two reconcilers at once never resolve the same charge twice', async () => {
    const pesa = make();
    for (let i = 0; i < 30; i++) await charge(pesa, `c${i}`);
    fake.queryLatencyMs = 25; // hold each query open so the two sweeps genuinely overlap
    advance(PAST_DEADLINE);

    const [a, b] = await Promise.all([make().reconcile({ concurrency: 4 }), make().reconcile({ concurrency: 4 })]);
    expect(a.checked + b.checked).toBe(30);
    expect(a.settled + b.settled).toBe(30);
    expect(new Set(fake.queryCalls).size).toBe(30);
    expect(fake.queryCalls).toHaveLength(30); // each charge was asked about exactly once
    expect(await outbox('settled')).toHaveLength(30); // and announced exactly once
  });

  it('a sweep honours its limit', async () => {
    const pesa = make();
    for (let i = 0; i < 12; i++) await charge(pesa, `c${i}`);
    advance(PAST_DEADLINE);
    expect(await pesa.reconcile({ limit: 5, concurrency: 2 })).toMatchObject({ checked: 5, settled: 5 });
    expect(await pesa.reconcile({ limit: 100 })).toMatchObject({ checked: 7, settled: 7 });
  });

  it('a failure on one charge does not abort the sweep, and that charge is retried after its lease', async () => {
    const pesa = make();
    const bad = await charge(pesa, 'bad');
    const good = await charge(pesa, 'good');
    advance(PAST_DEADLINE);

    const flaky = Object.assign(Object.create(store), {
      transition: (id: string, ...rest: unknown[]) =>
        id === bad.id ? Promise.reject(new Error('db blip')) : (store.transition as (...a: unknown[]) => Promise<Charge | null>)(id, ...rest),
    }) as Store;
    expect(await make({}, flaky).reconcile()).toMatchObject({ errors: 1, settled: 1 });
    expect(await stateOf(good.id)).toBe('settled');
    expect(await stateOf(bad.id)).toBe('awaiting_callback');

    advance(LEASE + 1000);
    expect(await pesa.reconcile()).toMatchObject({ settled: 1, errors: 0 });
    expect(await stateOf(bad.id)).toBe('settled');
  });
});

describe('reconcile(): racing a callback', () => {
  it('callback lands between the claim and the answer, and they DISAGREE: forward-only wins, a discrepancy is raised', async () => {
    const pesa = make();
    const c = await charge(pesa);
    fake.scriptQuery(c.checkoutRequestId!, { kind: 'done', resultCode: 1032 }); // query says failed
    fake.beforeQuery = async (id) => {
      await make().handleCallback({ rawBody: fake.callbackBody(id), sourceIp: SAFARICOM }); // callback says paid
    };
    advance(PAST_DEADLINE);

    const r = await pesa.reconcile();
    expect(r).toMatchObject({ discrepancies: 1, settled: 0, failed: 0 });
    expect(await stateOf(c.id)).toBe('settled'); // the recorded outcome is not overwritten
    const d = await outbox('discrepancy');
    expect(d).toHaveLength(1);
    expect(d[0].payload).toMatchObject({ source: 'reconciler', queryResultCode: 1032, recordedState: 'settled' });
    expect(await outbox('settled')).toHaveLength(1); // credited exactly once
  });

  it('callback lands first and they AGREE: no discrepancy, one settled event', async () => {
    const pesa = make();
    const c = await charge(pesa);
    fake.beforeQuery = async (id) => {
      await make().handleCallback({ rawBody: fake.callbackBody(id), sourceIp: SAFARICOM });
    };
    advance(PAST_DEADLINE);

    expect(await pesa.reconcile()).toMatchObject({ discrepancies: 0, settled: 0, stillWaiting: 1 });
    expect(await stateOf(c.id)).toBe('settled');
    expect(await outbox('discrepancy')).toHaveLength(0);
    expect(await outbox('settled')).toHaveLength(1);
  });

  it('a late contradictory callback after settlement raises a discrepancy with its payload kept', async () => {
    const pesa = make();
    const c = await charge(pesa);
    await pesa.handleCallback({ rawBody: fake.callbackBody(c.checkoutRequestId!), sourceIp: SAFARICOM });
    const late = await pesa.handleCallback({
      rawBody: fake.callbackBody(c.checkoutRequestId!, { resultCode: 1032 }),
      sourceIp: SAFARICOM,
    });
    expect(late).toMatchObject({ applied: false, conflict: true });
    const d = await outbox('discrepancy');
    expect(d).toHaveLength(1);
    expect(d[0].payload).toMatchObject({ source: 'callback', callbackResultCode: 1032, recordedState: 'settled' });
  });
});

// Added after the first Stryker run: each test below kills a mutant that survived.
describe('reconcile(): boundaries, counters and the other direction of a disagreement', () => {
  it('a recorded FAILURE contradicted by a successful query raises a discrepancy (not just the reverse)', async () => {
    const pesa = make();
    const c = await charge(pesa);
    fake.beforeQuery = async (id) => {
      await make().handleCallback({ rawBody: fake.callbackBody(id, { resultCode: 1032 }), sourceIp: SAFARICOM });
    };
    advance(PAST_DEADLINE); // the query itself answers success by default

    expect(await pesa.reconcile()).toMatchObject({ discrepancies: 1, settled: 0, failed: 0 });
    expect(await stateOf(c.id)).toBe('failed');
    expect((await outbox('discrepancy'))[0].payload).toMatchObject({
      source: 'reconciler',
      queryResultCode: 0,
      recordedState: 'failed',
    });
  });

  it('a failed query is counted at exactly deadline + grace, not one tick later', async () => {
    const T = new Date();
    const pesa = make({ now: () => T });
    const c = await charge(pesa);
    fake.scriptQuery(c.checkoutRequestId!, { kind: 'error' });
    await pool.query('UPDATE dr_charges SET push_started_at = $2 WHERE id = $1', [
      c.id,
      new Date(T.getTime() - (DEADLINE + DEADLINE)), // default grace equals the deadline
    ]);
    await pesa.reconcile();
    expect((await store.get(c.id))?.queryFailures).toBe(1);
  });

  it('counts each outcome of a failing-query streak: waiting, waiting, then unresolved', async () => {
    const pesa = make();
    const c = await charge(pesa);
    fake.scriptQuery(c.checkoutRequestId!, { kind: 'error' }, { kind: 'error' }, { kind: 'error' });
    advance(PAST_GRACE);

    const seen = [];
    for (let i = 0; i < 3; i++) {
      seen.push(await pesa.reconcile());
      advance(LEASE + 1000);
    }
    expect(seen.map((r) => [r.stillWaiting, r.unresolved])).toEqual([[1, 0], [1, 0], [0, 1]]);
  });

  it('losing the race on the third failure counts as waiting, not unresolved, and the callback keeps its result', async () => {
    const pesa = make();
    const c = await charge(pesa);
    fake.scriptQuery(c.checkoutRequestId!, { kind: 'error' });
    await pool.query('UPDATE dr_charges SET query_failures = 2 WHERE id = $1', [c.id]);
    fake.beforeQuery = async (id) => {
      await make().handleCallback({ rawBody: fake.callbackBody(id), sourceIp: SAFARICOM });
    };
    advance(PAST_GRACE);

    expect(await pesa.reconcile()).toMatchObject({ unresolved: 0, stillWaiting: 1 });
    expect(await stateOf(c.id)).toBe('settled');
    expect(await outbox('unresolved')).toHaveLength(0);
  });

  it('a push_unknown charge that gained its id under the sweep is counted as waiting, not unresolved', async () => {
    fake.scriptPush('http500');
    const pesa = make();
    const c = await charge(pesa);
    expect(c.state).toBe('push_unknown');
    advance(PAST_DEADLINE);

    const raced = Object.assign(Object.create(store), {
      claimOverdue: async (o: Parameters<Store['claimOverdue']>[0]) => {
        const rows = await store.claimOverdue(o);
        await store.transition(c.id, 'push_unknown', 'awaiting_callback', { checkoutRequestId: 'ws_late' });
        return rows; // stale: still says push_unknown
      },
    }) as Store;
    // limit 1: one raced claim only. Unbounded, the loop would claim the now-awaiting charge again.
    expect(await make({}, raced).reconcile({ limit: 1 })).toMatchObject({ checked: 1, unresolved: 0, stillWaiting: 1 });
    expect(await stateOf(c.id)).toBe('awaiting_callback');
  });

  it('limit caps the batch even when concurrency is larger', async () => {
    const pesa = make();
    for (let i = 0; i < 12; i++) await charge(pesa, `c${i}`);
    advance(PAST_DEADLINE);
    expect(await pesa.reconcile({ limit: 3, concurrency: 5 })).toMatchObject({ checked: 3, settled: 3 });
    expect(fake.queryCalls).toHaveLength(3);
  });
});

describe('handleCallback(): outbox side effects', () => {
  it('an identical duplicate of a settled callback raises NO discrepancy', async () => {
    const pesa = make();
    const c = await charge(pesa);
    const body = fake.callbackBody(c.checkoutRequestId!);
    await pesa.handleCallback({ rawBody: body, sourceIp: SAFARICOM });
    const dup = await pesa.handleCallback({ rawBody: body, sourceIp: SAFARICOM });
    expect(dup).toMatchObject({ applied: false, duplicate: true, conflict: false, reason: 'already_terminal' });
    expect(await outbox('discrepancy')).toHaveLength(0);
  });

  it('a callback that cannot move a non-terminal charge is "not_applicable" and writes nothing', async () => {
    const pesa = make();
    const c = await charge(pesa);
    await pool.query("UPDATE dr_charges SET state = 'pending' WHERE id = $1", [c.id]); // id bound, push not yet accounted for
    const r = await pesa.handleCallback({ rawBody: fake.callbackBody(c.checkoutRequestId!), sourceIp: SAFARICOM });
    expect(r).toMatchObject({ applied: false, duplicate: false, conflict: false, reason: 'not_applicable' });
    expect(await outbox()).toHaveLength(0);
    expect(await stateOf(c.id)).toBe('pending');
  });

  it('a receipt already used by another charge raises a discrepancy that says exactly what happened', async () => {
    const pesa = make();
    const a = await charge(pesa, 'a');
    const b = await charge(pesa, 'b');
    await pesa.handleCallback({ rawBody: fake.callbackBody(a.checkoutRequestId!, { receipt: 'RSHARED1' }), sourceIp: SAFARICOM });
    const r = await pesa.handleCallback({
      rawBody: fake.callbackBody(b.checkoutRequestId!, { receipt: 'RSHARED1' }),
      sourceIp: SAFARICOM,
    });
    expect(r).toMatchObject({ applied: false, conflict: true, reason: 'receipt_already_used' });
    const d = await outbox('discrepancy');
    expect(d).toHaveLength(1);
    expect(d[0].charge_id).toBe(b.id);
    expect(d[0].payload).toEqual({
      source: 'callback',
      reason: 'receipt_already_used',
      receipt: 'RSHARED1',
      recordedState: 'awaiting_callback',
    });
  });
});

describe('outbox: an event exists if and only if its transition committed', () => {
  it('20 callbacks that all read stale state still write exactly ONE settled event', async () => {
    const c = await charge(make());
    const body = fake.callbackBody(c.checkoutRequestId!);
    const N = 20;
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const gated = Object.assign(Object.create(store), {
      getByCheckoutRequestId: async (id: string) => {
        const row = await store.getByCheckoutRequestId(id);
        if (++arrived === N) open();
        await gate;
        return row;
      },
    }) as Store;
    const racer = make({}, gated);
    const results = await Promise.all(Array.from({ length: N }, () => racer.handleCallback({ rawBody: body, sourceIp: SAFARICOM })));
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await outbox('settled')).toHaveLength(1);
  });

  it('a compare-and-set that loses writes no event, and non-announcing transitions write none', async () => {
    const { charge: row } = await store.insertIntent({ idempotencyKey: 'x', fingerprint: 'f', ...req });
    const [a, b] = await Promise.all([store.transition(row.id, 'pending', 'failed'), store.transition(row.id, 'pending', 'failed')]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await outbox('failed')).toHaveLength(1);

    const { charge: other } = await store.insertIntent({ idempotencyKey: 'y', fingerprint: 'f', ...req });
    await store.transition(other.id, 'pending', 'awaiting_callback', { checkoutRequestId: 'ws_Y' });
    expect((await store.get(other.id))?.checkoutRequestId).toBe('ws_Y'); // the patch is persisted by the move itself
    await store.transition(other.id, 'awaiting_callback', 'awaiting_callback'); // no-op move
    expect(await outbox()).toHaveLength(1); // still just the one `failed`
  });
});

describe('dispatch(): at-least-once delivery', () => {
  const settleOne = async (pesa: Reliable, k = 'inv-1') => {
    const c = await charge(pesa, k);
    await pesa.handleCallback({ rawBody: fake.callbackBody(c.checkoutRequestId!), sourceIp: SAFARICOM });
    return c;
  };

  it('hands handlers the charge, delivers once, and does not redeliver', async () => {
    const pesa = make();
    const seen: { charge: Charge; meta: EventMeta }[] = [];
    pesa.on('settled', (charge, meta) => void seen.push({ charge, meta }));
    const c = await settleOne(pesa);

    expect(await pesa.dispatch()).toEqual({ delivered: 1, failed: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.charge).toMatchObject({ id: c.id, state: 'settled' });
    expect(seen[0]!.meta).toMatchObject({ type: 'settled', attempt: 1 });

    expect(await pesa.dispatch()).toEqual({ delivered: 0, failed: 0 });
    expect(seen).toHaveLength(1);
  });

  it('events with no listener stay queued, and a process restarted later still delivers them', async () => {
    const before = make(); // no handlers registered, as in a process that crashed before wiring them
    const c = await settleOne(before);
    expect(await before.dispatch()).toEqual({ delivered: 0, failed: 0 });
    expect(await outbox('settled')).toHaveLength(1);
    expect((await outbox('settled'))[0].delivered_at).toBeNull();

    const after = make(); // "restart"
    const got: string[] = [];
    after.on('settled', (ch) => void got.push(ch.id));
    expect((await after.dispatch()).delivered).toBe(1);
    expect(got).toEqual([c.id]);
  });

  it('a handler that throws keeps the event, and it is redelivered after the delay with attempt=2', async () => {
    const pesa = make();
    const attempts: number[] = [];
    pesa.on('settled', (_c, meta) => {
      attempts.push(meta.attempt);
      if (meta.attempt === 1) throw new Error('ledger down');
    });
    await settleOne(pesa);

    expect(await pesa.dispatch()).toEqual({ delivered: 0, failed: 1 });
    expect(await pesa.dispatch()).toEqual({ delivered: 0, failed: 0 }); // backing off

    advance(30_000 + 1000);
    expect(await pesa.dispatch()).toEqual({ delivered: 1, failed: 0 });
    expect(attempts).toEqual([1, 2]);
    expect((await outbox('settled'))[0].delivered_at).not.toBeNull();
  });

  it('two dispatchers running at once deliver each event exactly once', async () => {
    const setup = make();
    for (let i = 0; i < 20; i++) await settleOne(setup, `c${i}`);

    const counts = new Map<string, number>();
    const worker = () => {
      const p = make();
      p.on('settled', async (c) => {
        await new Promise((r) => setTimeout(r, 5));
        counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
      });
      return (async () => {
        while ((await p.dispatch({ limit: 3 })).delivered > 0);
      })();
    };
    await Promise.all([worker(), worker()]);

    expect(counts.size).toBe(20);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });

  it('unsubscribing one handler leaves the others on that type running', async () => {
    const pesa = make();
    const ran: string[] = [];
    const offA = pesa.on('settled', () => void ran.push('a'));
    pesa.on('settled', () => void ran.push('b'));
    offA();
    offA(); // idempotent: must not remove b
    await settleOne(pesa);
    expect(await pesa.dispatch()).toEqual({ delivered: 1, failed: 0 });
    expect(ran).toEqual(['b']);
  });

  it('unsubscribe stops delivery, and a discrepancy event carries its detail', async () => {
    const pesa = make();
    const off = pesa.on('settled', () => {
      throw new Error('should not run');
    });
    off();
    const details: unknown[] = [];
    pesa.on('discrepancy', (_c, m) => void details.push(m.detail));

    const c = await settleOne(pesa);
    await pesa.handleCallback({ rawBody: fake.callbackBody(c.checkoutRequestId!, { resultCode: 1032 }), sourceIp: SAFARICOM });
    expect(await pesa.dispatch()).toEqual({ delivered: 1, failed: 0 });
    expect(details[0]).toMatchObject({ callbackResultCode: 1032, recordedState: 'settled' });
    expect(await outbox('settled')).toHaveLength(1); // untouched: nobody listens for it
  });
});
