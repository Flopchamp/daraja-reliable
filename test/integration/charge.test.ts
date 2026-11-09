import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createReliableDaraja, IdempotencyConflictError, ValidationError, fingerprint } from '../../src/reliable.js';
import type { PostgresStore } from '../../src/pg-store.js';
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

const make = (now?: () => Date) => createReliableDaraja({ transport: fake, store, trustedSourceIps: 'disabled', ...(now ? { now } : {}) });
const key = (k = 'invoice-1') => ({ idempotencyKey: k, ...req });
const rowCount = async () => Number((await pool.query('SELECT count(*) FROM dr_charges')).rows[0].count);

describe('charge(): idempotent initiation', () => {
  it('same key, 50 concurrent calls: exactly one push reaches the transport', async () => {
    fake.latencyMs = 40; // keep the winner in flight while the other 49 arrive
    const pesa = make();
    const results = await Promise.all(Array.from({ length: 50 }, () => pesa.charge(key())));

    expect(fake.pushCalls).toHaveLength(1);
    expect(await rowCount()).toBe(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(49);
  });

  it('a successful push stores the CheckoutRequestID and awaits the callback', async () => {
    const r = await make().charge(key());
    expect(r.state).toBe('awaiting_callback');
    expect(r.checkoutRequestId).toMatch(/^ws_CO_/);
    expect(r.replayed).toBe(false);
  });

  it('calling again later returns the original and does not push', async () => {
    const pesa = make();
    const first = await pesa.charge(key());
    const second = await pesa.charge(key());
    expect(second).toMatchObject({ id: first.id, state: 'awaiting_callback', replayed: true });
    expect(fake.pushCalls).toHaveLength(1);
  });

  it('same key with a different amount is a conflict, not a silent replay', async () => {
    const pesa = make();
    await pesa.charge(key());
    await expect(pesa.charge({ ...key(), amount: 9999 })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(fake.pushCalls).toHaveLength(1);
  });

  it('invalid input is rejected before anything is written', async () => {
    const pesa = make();
    await expect(pesa.charge({ ...key(), phone: '0712345678' })).rejects.toBeInstanceOf(ValidationError);
    await expect(pesa.charge({ ...key(), amount: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(pesa.charge({ ...key(), amount: 10.5 })).rejects.toBeInstanceOf(ValidationError);
    expect(await rowCount()).toBe(0);
    expect(fake.pushCalls).toHaveLength(0);
  });
});

describe('charge(): push outcomes', () => {
  it('a definitive refusal fails the charge and a retry does not push again', async () => {
    fake.scriptPush('reject');
    const pesa = make();
    expect((await pesa.charge(key())).state).toBe('failed');
    expect((await pesa.charge(key())).replayed).toBe(true);
    expect(fake.pushCalls).toHaveLength(1);
  });

  it.each(['http500', 'hang'] as const)('%s is ambiguous: push_unknown, and a retry never pushes again', async (b) => {
    fake.scriptPush(b);
    const pesa = make();
    const r = await pesa.charge(key());
    expect(r.state).toBe('push_unknown');
    expect(r.checkoutRequestId).toBeNull();

    const again = await pesa.charge(key());
    expect(again).toMatchObject({ id: r.id, state: 'push_unknown', replayed: true });
    expect(fake.pushCalls).toHaveLength(1);
  });

  it('a push that reached Safaricom but whose response was lost is push_unknown with nothing to query', async () => {
    fake.scriptPush('ok_but_response_lost');
    const pesa = make();
    const r = await pesa.charge(key());
    expect(fake.registered.size).toBe(1); // the customer really was prompted
    expect(r).toMatchObject({ state: 'push_unknown', checkoutRequestId: null });
    await pesa.charge(key());
    expect(fake.pushCalls).toHaveLength(1); // and we did not prompt them twice
  });
});

describe('recover(): crash between intent write and recording the outcome', () => {
  it('a stale pending row becomes push_unknown, is never re-pushed, and is audited', async () => {
    // Simulate the crash: the intent row exists, the process died before the push outcome was stored.
    const { charge: stuck } = await store.insertIntent({
      idempotencyKey: 'crashed', fingerprint: fingerprint(req), ...req,
    });
    expect(stuck.state).toBe('pending');

    const later = () => new Date(Date.now() + 120_000);
    const moved = await make(later).recover({ olderThanMs: 60_000 });
    expect(moved.map((c) => c.id)).toEqual([stuck.id]);
    expect((await store.get(stuck.id))?.state).toBe('push_unknown');

    const again = await make().charge({ idempotencyKey: 'crashed', ...req });
    expect(again).toMatchObject({ state: 'push_unknown', replayed: true });
    expect(fake.pushCalls).toHaveLength(0);

    const audit = await pool.query("SELECT to_state FROM dr_audit WHERE charge_id = $1 AND kind = 'transition'", [stuck.id]);
    expect(audit.rows.map((r) => r.to_state)).toEqual(['push_unknown']);
  });

  it('a fresh pending row (push still in flight) is left alone', async () => {
    const { charge } = await store.insertIntent({ idempotencyKey: 'fresh', fingerprint: fingerprint(req), ...req });
    expect(await make().recover({ olderThanMs: 60_000 })).toHaveLength(0);
    expect((await store.get(charge.id))?.state).toBe('pending');
  });
});

describe('PostgresStore: atomic transitions and leases', () => {
  it('two concurrent compare-and-set transitions: exactly one wins', async () => {
    const { charge } = await store.insertIntent({ idempotencyKey: 'cas', fingerprint: 'f', ...req });
    const results = await Promise.all([
      store.transition(charge.id, 'pending', 'awaiting_callback', { checkoutRequestId: 'A' }),
      store.transition(charge.id, 'pending', 'failed'),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('a transition from the wrong expected state changes nothing', async () => {
    const { charge } = await store.insertIntent({ idempotencyKey: 'cas2', fingerprint: 'f', ...req });
    expect(await store.transition(charge.id, 'settled', 'failed')).toBeNull();
    expect((await store.get(charge.id))?.state).toBe('pending');
  });

  it('claimOverdue: two claimers at once never receive the same row, and leases hold', async () => {
    for (let i = 0; i < 30; i++) {
      const { charge } = await store.insertIntent({ idempotencyKey: `c${i}`, fingerprint: 'f', ...req });
      await store.transition(charge.id, 'pending', 'awaiting_callback', { checkoutRequestId: `ws_${i}` });
    }
    const now = new Date(Date.now() + 10_000);
    const opts = { before: new Date(Date.now() + 5_000), limit: 100, leaseMs: 60_000, now };
    const [a, b] = await Promise.all([store.claimOverdue(opts), store.claimOverdue(opts)]);

    const ids = [...a, ...b].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // disjoint
    expect(ids).toHaveLength(30); // and complete
    expect(await store.claimOverdue(opts)).toHaveLength(0); // leased rows stay hidden

    const after = await store.claimOverdue({ ...opts, now: new Date(now.getTime() + 61_000) });
    expect(after).toHaveLength(30); // expired leases are claimable again
  });

  it('terminal rows are never claimed', async () => {
    const { charge } = await store.insertIntent({ idempotencyKey: 'done', fingerprint: 'f', ...req });
    await store.transition(charge.id, 'pending', 'awaiting_callback', { checkoutRequestId: 'X' });
    await store.transition(charge.id, 'awaiting_callback', 'settled');
    const now = new Date(Date.now() + 10_000);
    expect(await store.claimOverdue({ before: now, limit: 10, leaseMs: 1000, now })).toHaveLength(0);
  });
});
