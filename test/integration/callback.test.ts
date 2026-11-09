import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createReliableDaraja, type Reliable } from '../../src/reliable.js';
import type { PostgresStore } from '../../src/pg-store.js';
import { FakeDaraja } from '../../src/testing/fake-daraja.js';
import { freshDb, req } from './helpers.js';

const SAFARICOM = '196.201.214.200';
const TRUSTED = ['196.201.214.0/24'];

let pool: pg.Pool;
let store: PostgresStore;
let fake: FakeDaraja;
let pesa: Reliable;

beforeEach(async () => {
  ({ pool, store } = await freshDb());
  fake = new FakeDaraja();
  pesa = createReliableDaraja({ transport: fake, store, trustedSourceIps: TRUSTED });
});
afterAll(async () => {
  await pool?.end();
});

const charge = (k = 'inv-1') => pesa.charge({ idempotencyKey: k, ...req });
const cb = (body: string, ip = SAFARICOM) => pesa.handleCallback({ rawBody: body, sourceIp: ip });
const stateOf = async (id: string) => (await store.get(id))?.state;
const audit = async (kind: string) =>
  (await pool.query('SELECT * FROM dr_audit WHERE kind = $1 ORDER BY id', [kind])).rows;

describe('handleCallback(): applying a callback', () => {
  it('a success callback settles the charge and records the receipt', async () => {
    const c = await charge();
    const r = await cb(fake.callbackBody(c.checkoutRequestId!, { receipt: 'RCPT1' }));
    expect(r).toMatchObject({ applied: true, duplicate: false, conflict: false, reason: 'applied' });
    expect(r.charge).toMatchObject({ state: 'settled', receipt: 'RCPT1' });
  });

  it('a failure callback fails the charge, with no receipt', async () => {
    const c = await charge();
    const r = await cb(fake.callbackBody(c.checkoutRequestId!, { resultCode: 1032 }));
    expect(r.applied).toBe(true);
    expect(r.charge).toMatchObject({ state: 'failed', receipt: null });
  });

  it('accepts the body as bytes (a Buffer straight from express.raw)', async () => {
    const c = await charge();
    const r = await pesa.handleCallback({ rawBody: Buffer.from(fake.callbackBody(c.checkoutRequestId!)), sourceIp: SAFARICOM });
    expect(r.applied).toBe(true);
  });

  it('an IPv4-mapped IPv6 peer address from a trusted range is accepted', async () => {
    const c = await charge();
    expect((await cb(fake.callbackBody(c.checkoutRequestId!), `::ffff:${SAFARICOM}`)).applied).toBe(true);
  });

  it('retains the raw payload before changing state', async () => {
    const c = await charge();
    const body = fake.callbackBody(c.checkoutRequestId!);
    await cb(body);
    const rows = await audit('callback_raw');
    expect(rows).toHaveLength(1);
    expect(rows[0].raw_payload).toBe(body);
    expect(rows[0].charge_id).toBe(c.id);
  });
});

describe('handleCallback(): replay safety', () => {
  it('delivered twice: credited once, the second is a duplicate and state is unchanged', async () => {
    const c = await charge();
    const body = fake.callbackBody(c.checkoutRequestId!);
    const first = await cb(body);
    const second = await cb(body);
    expect(first.applied).toBe(true);
    expect(second).toMatchObject({ applied: false, duplicate: true, conflict: false, reason: 'already_terminal' });
    expect(await stateOf(c.id)).toBe('settled');
  });

  it('20 identical callbacks racing: exactly one is applied', async () => {
    const c = await charge();
    const body = fake.callbackBody(c.checkoutRequestId!);
    const results = await Promise.all(Array.from({ length: 20 }, () => cb(body)));
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(19);
    expect(await stateOf(c.id)).toBe('settled');
  });

  it('20 callbacks that ALL read the stale awaiting_callback row still apply exactly once (the CAS decides, not the read)', async () => {
    const c = await charge();
    const body = fake.callbackBody(c.checkoutRequestId!);

    // Barrier: no caller proceeds past its read until all 20 have read, so every one holds a
    // stale view and the compare-and-set is the only thing separating winner from losers.
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
    }) as PostgresStore;
    const racer = createReliableDaraja({ transport: fake, store: gated, trustedSourceIps: TRUSTED });

    const results = await Promise.all(
      Array.from({ length: N }, () => racer.handleCallback({ rawBody: body, sourceIp: SAFARICOM })),
    );
    expect(arrived).toBe(N);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(N - 1);
    expect(await stateOf(c.id)).toBe('settled');
    expect(await audit('transition')).toHaveLength(2); // push_accepted + exactly one callback
  });

  it('a late failure after settled leaves it settled, is flagged as a conflict, and the payload is kept', async () => {
    const c = await charge();
    await cb(fake.callbackBody(c.checkoutRequestId!));
    const lateBody = fake.callbackBody(c.checkoutRequestId!, { resultCode: 1032 });
    const late = await cb(lateBody);
    expect(late).toMatchObject({ applied: false, duplicate: true, conflict: true });
    expect(await stateOf(c.id)).toBe('settled');
    expect((await audit('callback_raw')).map((r) => r.raw_payload)).toContain(lateBody);
  });

  it('a late success after failed leaves it failed and flags the conflict', async () => {
    const c = await charge();
    await cb(fake.callbackBody(c.checkoutRequestId!, { resultCode: 1032 }));
    const late = await cb(fake.callbackBody(c.checkoutRequestId!));
    expect(late).toMatchObject({ applied: false, duplicate: true, conflict: true });
    expect(await stateOf(c.id)).toBe('failed');
  });

  it('an unresolved charge that holds its id is settled by a real late callback', async () => {
    const c = await charge();
    await store.transition(c.id, 'awaiting_callback', 'unresolved');
    const r = await cb(fake.callbackBody(c.checkoutRequestId!));
    expect(r.applied).toBe(true);
    expect(await stateOf(c.id)).toBe('settled');
  });

  it('one receipt cannot settle two charges', async () => {
    const a = await charge('inv-a');
    const b = await charge('inv-b');
    expect((await cb(fake.callbackBody(a.checkoutRequestId!, { receipt: 'SAME' }))).applied).toBe(true);
    const second = await cb(fake.callbackBody(b.checkoutRequestId!, { receipt: 'SAME' }));
    expect(second).toMatchObject({ applied: false, conflict: true, reason: 'receipt_already_used' });
    expect(await stateOf(b.id)).toBe('awaiting_callback');
  });
});

describe('handleCallback(): inputs that must never move money', () => {
  it('an untrusted source IP is rejected, retained, and changes nothing', async () => {
    const c = await charge();
    const body = fake.callbackBody(c.checkoutRequestId!);
    const r = await cb(body, '203.0.113.9');
    expect(r).toMatchObject({ applied: false, reason: 'untrusted_source', charge: null });
    expect(await stateOf(c.id)).toBe('awaiting_callback');
    const rows = await audit('untrusted_source');
    expect(rows).toHaveLength(1);
    expect(rows[0].raw_payload).toBe(body);
  });

  it('a spoofed callback is harmless even from a trusted-looking neighbour outside the range', async () => {
    const c = await charge();
    for (const ip of ['196.201.215.1', '196.201.213.255', '', 'garbage']) {
      expect((await cb(fake.callbackBody(c.checkoutRequestId!), ip)).reason).toBe('untrusted_source');
    }
    expect(await stateOf(c.id)).toBe('awaiting_callback');
  });

  it("'disabled' skips the origin check (an explicit opt-out)", async () => {
    const open = createReliableDaraja({ transport: fake, store, trustedSourceIps: 'disabled' });
    const c = await open.charge({ idempotencyKey: 'x', ...req });
    expect((await open.handleCallback({ rawBody: fake.callbackBody(c.checkoutRequestId!), sourceIp: '203.0.113.9' })).applied).toBe(true);
  });

  it('malformed bodies return a result (never throw), are retained, and change nothing', async () => {
    const c = await charge();
    const bodies = ['', 'not json', '{"Body":{}}', '[]', 'null', JSON.stringify({ Body: { stkCallback: { ResultCode: 0 } } })];
    for (const b of bodies) {
      const r = await cb(b);
      expect(r).toMatchObject({ applied: false, reason: 'malformed' });
    }
    expect(await stateOf(c.id)).toBe('awaiting_callback');
    expect((await audit('malformed')).map((r) => r.raw_payload)).toEqual(bodies);
  });

  it('a callback for an id we never issued is retained and changes nothing', async () => {
    const c = await charge();
    const stranger = JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: 'ws_CO_UNKNOWN', ResultCode: 0 } } });
    const r = await cb(stranger);
    expect(r).toMatchObject({ applied: false, reason: 'unknown_charge', charge: null });
    expect(await stateOf(c.id)).toBe('awaiting_callback');
    expect((await audit('callback_raw'))[0].raw_payload).toBe(stranger);
  });

  it('a callback for a push whose response we lost cannot settle the push_unknown charge', async () => {
    fake.scriptPush('ok_but_response_lost');
    const lost = await charge();
    expect(lost.state).toBe('push_unknown');
    const realId = [...fake.registered.keys()][0]!; // the customer was prompted and pays

    const r = await cb(fake.callbackBody(realId));
    expect(r).toMatchObject({ applied: false, reason: 'unknown_charge' });
    expect(await stateOf(lost.id)).toBe('push_unknown'); // a human decides; we never guess by phone+amount
    expect(await audit('callback_raw')).toHaveLength(1); // but the evidence is kept
  });

  it('a callback for a charge that is still pending cannot move it', async () => {
    const { charge: pending } = await store.insertIntent({ idempotencyKey: 'p', fingerprint: 'f', ...req });
    // `pending` has no checkoutRequestId, so nothing can bind to it.
    const r = await cb(JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: 'ws_CO_X', ResultCode: 0 } } }));
    expect(r.reason).toBe('unknown_charge');
    expect(await stateOf(pending.id)).toBe('pending');
  });
});
