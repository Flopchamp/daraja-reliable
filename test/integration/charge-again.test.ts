import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createReliableDaraja, NotRetryableError, ValidationError, type Reliable } from '../../src/reliable.js';
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

const make = (): Reliable => createReliableDaraja({ transport: fake, store, trustedSourceIps: 'disabled' });
const YES = { acknowledgeDuplicateRisk: true } as const;
const stateOf = async (id: string) => (await store.get(id))?.state;
const outbox = async (type?: string) =>
  (await pool.query(`SELECT * FROM dr_outbox ${type ? 'WHERE type = $1' : ''} ORDER BY id`, type ? [type] : [])).rows;
const pay = (pesa: Reliable, checkoutRequestId: string) =>
  pesa.handleCallback({ rawBody: fake.callbackBody(checkoutRequestId), sourceIp: '196.201.214.200' });

/** A charge whose push response was lost: the customer may have been prompted, we cannot tell. */
const lost = async (pesa: Reliable, key = 'inv-1') => {
  fake.scriptPush('http500');
  const c = await pesa.charge({ idempotencyKey: key, ...req });
  expect(c.state).toBe('push_unknown');
  return c;
};
/** An unresolved charge that DOES hold its id: the first prompt is live and may still be paid. */
const unresolvedWithId = async (pesa: Reliable, key = 'inv-1') => {
  const c = await pesa.charge({ idempotencyKey: key, ...req });
  expect(c.checkoutRequestId).not.toBeNull();
  await pool.query("UPDATE dr_charges SET state = 'unresolved' WHERE id = $1", [c.id]);
  return c;
};

describe('chargeAgain(): the guard rails', () => {
  it('refuses without the explicit acknowledgement, and sends nothing', async () => {
    const pesa = make();
    const c = await lost(pesa);
    // @ts-expect-error the flag is required by the type as well as at runtime
    await expect(pesa.chargeAgain(c.id, {})).rejects.toBeInstanceOf(ValidationError);
    // @ts-expect-error only the literal `true` is accepted
    await expect(pesa.chargeAgain(c.id, { acknowledgeDuplicateRisk: false })).rejects.toBeInstanceOf(ValidationError);
    expect(fake.pushCalls).toHaveLength(1); // just the original
  });

  it('rejects an id that does not exist', async () => {
    await expect(make().chargeAgain('00000000-0000-0000-0000-000000000000', YES)).rejects.toBeInstanceOf(ValidationError);
    expect(fake.pushCalls).toHaveLength(0);
  });

  it.each([
    ['awaiting_callback: a live prompt is already being chased', async (p: Reliable) => (await p.charge({ idempotencyKey: 'k', ...req })).id],
    [
      'settled: it was paid',
      async (p: Reliable) => {
        const c = await p.charge({ idempotencyKey: 'k', ...req });
        await pay(p, c.checkoutRequestId!);
        return c.id;
      },
    ],
    [
      'failed: a definite answer, so a retry is just a new charge()',
      async (p: Reliable) => {
        fake.scriptPush('reject');
        return (await p.charge({ idempotencyKey: 'k', ...req })).id;
      },
    ],
    ['pending: the push may still be in flight', async () => (await store.insertIntent({ idempotencyKey: 'k', fingerprint: 'f', ...req })).charge.id],
  ])('refuses %s, sends nothing and writes nothing', async (_label, setup) => {
    const pesa = make();
    const id = await setup(pesa);
    const pushes = fake.pushCalls.length;
    const rows = (await pool.query('SELECT count(*)::int AS n FROM dr_charges')).rows[0].n;

    await expect(pesa.chargeAgain(id, YES)).rejects.toBeInstanceOf(NotRetryableError);
    expect(fake.pushCalls).toHaveLength(pushes);
    expect((await pool.query('SELECT count(*)::int AS n FROM dr_charges')).rows[0].n).toBe(rows);
  });

  it('a refusal leaves no row behind to block a later, legitimate retry', async () => {
    const pesa = make();
    const c = await pesa.charge({ idempotencyKey: 'k', ...req }); // awaiting_callback
    await expect(pesa.chargeAgain(c.id, YES)).rejects.toBeInstanceOf(NotRetryableError);

    await pool.query("UPDATE dr_charges SET state = 'unresolved' WHERE id = $1", [c.id]); // it later becomes unresolved
    const again = await pesa.chargeAgain(c.id, YES);
    expect(again).toMatchObject({ replayed: false, state: 'awaiting_callback' });
    expect(fake.pushCalls).toHaveLength(2);
  });
});

describe('chargeAgain(): a second prompt, exactly once', () => {
  it('from push_unknown: a new linked charge is pushed once, and the old one is left alone', async () => {
    const pesa = make();
    const old = await lost(pesa);

    const again = await pesa.chargeAgain(old.id, YES);
    expect(again).toMatchObject({ replayed: false, state: 'awaiting_callback' });
    expect(again.id).not.toBe(old.id);
    expect(again.checkoutRequestId).not.toBeNull();

    const child = (await store.get(again.id))!;
    expect(child).toMatchObject({ rootId: old.id, attempt: 2, phone: req.phone, amount: req.amount, accountRef: req.accountRef });
    expect(await stateOf(old.id)).toBe('push_unknown'); // untouched: a person resolves it
    expect(fake.pushCalls).toHaveLength(2);
    expect(fake.pushCalls[1]).toEqual(fake.pushCalls[0]); // same phone, amount and reference
  });

  it('from unresolved works too', async () => {
    const pesa = make();
    const c = await unresolvedWithId(pesa);
    expect(await pesa.chargeAgain(c.id, YES)).toMatchObject({ replayed: false, state: 'awaiting_callback' });
    expect(fake.pushCalls).toHaveLength(2);
  });

  it('asking again returns the same retry and never prompts a third time', async () => {
    const pesa = make();
    const old = await lost(pesa);
    const first = await pesa.chargeAgain(old.id, YES);
    const second = await pesa.chargeAgain(old.id, YES);
    expect(second).toMatchObject({ id: first.id, replayed: true });
    expect(fake.pushCalls).toHaveLength(2);
  });

  it('five callers racing prompt the customer once between them', async () => {
    const pesa = make();
    const old = await lost(pesa);
    fake.latencyMs = 30; // keep the winner's push open so the others genuinely overlap it
    const results = await Promise.all(Array.from({ length: 5 }, () => make().chargeAgain(old.id, YES)));

    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(fake.pushCalls).toHaveLength(2); // the original and exactly one retry
  });

  it('asking again after the old charge has since resolved still returns the existing retry, not a refusal', async () => {
    const pesa = make();
    const old = await unresolvedWithId(pesa);
    const first = await pesa.chargeAgain(old.id, YES);
    await pay(pesa, old.checkoutRequestId!); // the old prompt was paid after all: no longer retryable

    const second = await pesa.chargeAgain(old.id, YES);
    expect(second).toMatchObject({ id: first.id, replayed: true });
    expect(fake.pushCalls).toHaveLength(2);
  });

  it('a caller whose early lookup missed the retry still does not push if another caller created it', async () => {
    const pesa = make();
    const old = await lost(pesa);
    // Every caller reads "no retry yet" before anyone has inserted one: the worst interleaving.
    // Only insertIntent's ON CONFLICT can now say who created the row, and so who pushes.
    const blind = Object.assign(Object.create(store), { getByIdempotencyKey: async () => null }) as Store;
    const racers = [0, 1, 2].map(() => createReliableDaraja({ transport: fake, store: blind, trustedSourceIps: 'disabled' }));

    const results = await Promise.all(racers.map((r) => r.chargeAgain(old.id, YES)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(fake.pushCalls).toHaveLength(2); // the original and exactly one retry
  });

  it('the retry of a retry keeps the same root and counts the attempts', async () => {
    const pesa = make();
    const old = await lost(pesa);
    fake.scriptPush('http500'); // the retry is lost as well
    const second = await pesa.chargeAgain(old.id, YES);
    expect(second.state).toBe('push_unknown');

    const third = await pesa.chargeAgain(second.id, YES);
    expect(third).toMatchObject({ replayed: false, state: 'awaiting_callback' });
    expect(await store.get(third.id)).toMatchObject({ rootId: old.id, attempt: 3 });
    expect(fake.pushCalls).toHaveLength(3);
  });

  it('records the retry on the old charge\'s audit trail', async () => {
    const pesa = make();
    const old = await lost(pesa);
    const again = await pesa.chargeAgain(old.id, YES);
    const rows = (await pool.query("SELECT * FROM dr_audit WHERE kind = 'retry' AND charge_id = $1", [old.id])).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].raw_payload)).toEqual({ retriedAs: again.id, attempt: 2 });
  });

  it('a retry whose own push is lost is push_unknown like any other, and can be retried in turn', async () => {
    const pesa = make();
    const old = await lost(pesa);
    fake.scriptPush('ok_but_response_lost');
    const second = await pesa.chargeAgain(old.id, YES);
    expect(second.state).toBe('push_unknown');
    expect(second.checkoutRequestId).toBeNull();
  });
});

describe('chargeAgain(): each prompt keeps its own identity', () => {
  it('a late callback for the OLD prompt still binds to the old charge, not the retry', async () => {
    const pesa = make();
    const old = await unresolvedWithId(pesa);
    const again = await pesa.chargeAgain(old.id, YES);
    expect(again.checkoutRequestId).not.toBe(old.checkoutRequestId);

    const r = await pay(pesa, old.checkoutRequestId!);
    expect(r).toMatchObject({ applied: true, reason: 'applied' });
    expect(r.charge!.id).toBe(old.id);
    expect(await stateOf(old.id)).toBe('settled');
    expect(await stateOf(again.id)).toBe('awaiting_callback'); // the retry is a separate fact
  });
});

describe('chargeAgain(): when both prompts get paid', () => {
  it('the SECOND to settle raises a duplicate_payment discrepancy naming the first; the first raises none', async () => {
    const pesa = make();
    const old = await unresolvedWithId(pesa);
    const again = await pesa.chargeAgain(old.id, YES);

    await pay(pesa, again.checkoutRequestId!);
    expect(await outbox('discrepancy')).toHaveLength(0); // one payment so far: nothing to say

    await pay(pesa, old.checkoutRequestId!);
    const d = await outbox('discrepancy');
    expect(d).toHaveLength(1);
    expect(d[0].charge_id).toBe(old.id);
    expect(d[0].payload).toEqual({ source: 'retry_chain', reason: 'duplicate_payment', otherSettledChargeIds: [again.id] });
    expect(await outbox('settled')).toHaveLength(2); // both did settle: nothing is reversed or hidden
  });

  it('works in the other order, and reaches a handler with rootId to dedupe fulfilment on', async () => {
    const pesa = make();
    const old = await unresolvedWithId(pesa);
    const again = await pesa.chargeAgain(old.id, YES);
    const seen: { id: string; rootId: string | null; detail: unknown }[] = [];
    pesa.on('discrepancy', (c, m) => void seen.push({ id: c.id, rootId: c.rootId, detail: m.detail }));

    await pay(pesa, old.checkoutRequestId!);
    await pay(pesa, again.checkoutRequestId!);
    await pesa.dispatch();

    expect(seen).toEqual([
      {
        id: again.id,
        rootId: old.id,
        detail: { source: 'retry_chain', reason: 'duplicate_payment', otherSettledChargeIds: [old.id] },
      },
    ]);
  });

  it('two prompts settling at the same instant: at least one of them notices', async () => {
    const pesa = make();
    const old = await unresolvedWithId(pesa);
    const again = await pesa.chargeAgain(old.id, YES);

    await Promise.all([pay(make(), old.checkoutRequestId!), pay(make(), again.checkoutRequestId!)]);
    expect(await stateOf(old.id)).toBe('settled');
    expect(await stateOf(again.id)).toBe('settled');
    expect((await outbox('discrepancy')).length).toBeGreaterThanOrEqual(1);
  });

  it('an ordinary charge that settles raises no such discrepancy', async () => {
    const pesa = make();
    const c = await pesa.charge({ idempotencyKey: 'plain', ...req });
    await pay(pesa, c.checkoutRequestId!);
    expect(await outbox('discrepancy')).toHaveLength(0);
  });

  it('a retry that settles while the old charge is merely unresolved is NOT a duplicate', async () => {
    const pesa = make();
    const old = await unresolvedWithId(pesa);
    const again = await pesa.chargeAgain(old.id, YES);
    await pay(pesa, again.checkoutRequestId!);
    expect(await stateOf(old.id)).toBe('unresolved');
    expect(await outbox('discrepancy')).toHaveLength(0);
  });
});
