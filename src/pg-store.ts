import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { State } from './state.js';
import type { AuditEntry, Charge, NewCharge, Store } from './store.js';

interface Row {
  id: string;
  idempotency_key: string;
  fingerprint: string;
  phone: string;
  amount: number;
  account_ref: string;
  state: State;
  checkout_request_id: string | null;
  attempt: number;
  query_failures: number;
  push_started_at: Date;
  claimed_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

const toCharge = (r: Row): Charge => ({
  id: r.id,
  idempotencyKey: r.idempotency_key,
  fingerprint: r.fingerprint,
  phone: r.phone,
  amount: r.amount,
  accountRef: r.account_ref,
  state: r.state,
  checkoutRequestId: r.checkout_request_id,
  attempt: r.attempt,
  queryFailures: r.query_failures,
  pushStartedAt: r.push_started_at,
  claimedUntil: r.claimed_until,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Applies every migrations/*.sql in name order. Each file is idempotent (IF NOT EXISTS). */
export async function migrate(pool: Pool): Promise<void> {
  const dir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await pool.query(readFileSync(join(dir, f), 'utf8'));
  }
}

export class PostgresStore implements Store {
  constructor(private readonly pool: Pool) {}

  async insertIntent(c: NewCharge): Promise<{ charge: Charge; created: boolean }> {
    // ON CONFLICT DO NOTHING blocks on a concurrent uncommitted insert of the same key,
    // then skips; the SELECT below (a fresh statement) sees the winner's committed row.
    const ins = await this.pool.query<Row>(
      `INSERT INTO dr_charges (idempotency_key, fingerprint, phone, amount, account_ref, state)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [c.idempotencyKey, c.fingerprint, c.phone, c.amount, c.accountRef],
    );
    if (ins.rows[0]) return { charge: toCharge(ins.rows[0]), created: true };

    const sel = await this.pool.query<Row>('SELECT * FROM dr_charges WHERE idempotency_key = $1', [
      c.idempotencyKey,
    ]);
    const row = sel.rows[0];
    if (!row) throw new Error('insertIntent: conflict reported but no row found');
    return { charge: toCharge(row), created: false };
  }

  async get(id: string): Promise<Charge | null> {
    const r = await this.pool.query<Row>('SELECT * FROM dr_charges WHERE id = $1', [id]);
    return r.rows[0] ? toCharge(r.rows[0]) : null;
  }

  async getByCheckoutRequestId(checkoutRequestId: string): Promise<Charge | null> {
    const r = await this.pool.query<Row>('SELECT * FROM dr_charges WHERE checkout_request_id = $1', [
      checkoutRequestId,
    ]);
    return r.rows[0] ? toCharge(r.rows[0]) : null;
  }

  async transition(
    id: string,
    from: State,
    to: State,
    patch: { checkoutRequestId?: string; queryFailures?: number } = {},
  ): Promise<Charge | null> {
    const r = await this.pool.query<Row>(
      `UPDATE dr_charges
          SET state = $3,
              checkout_request_id = COALESCE($4, checkout_request_id),
              query_failures = COALESCE($5, query_failures),
              claimed_until = NULL,
              updated_at = now()
        WHERE id = $1 AND state = $2
        RETURNING *`,
      [id, from, to, patch.checkoutRequestId ?? null, patch.queryFailures ?? null],
    );
    return r.rows[0] ? toCharge(r.rows[0]) : null;
  }

  async claimOverdue(opts: { before: Date; limit: number; leaseMs: number; now: Date }): Promise<Charge[]> {
    const leaseUntil = new Date(opts.now.getTime() + opts.leaseMs);
    const r = await this.pool.query<Row>(
      `UPDATE dr_charges SET claimed_until = $4
        WHERE id IN (
          SELECT id FROM dr_charges
           WHERE state IN ('awaiting_callback','push_unknown')
             AND push_started_at < $1
             AND (claimed_until IS NULL OR claimed_until < $3)
           ORDER BY push_started_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [opts.before, opts.limit, opts.now, leaseUntil],
    );
    return r.rows.map(toCharge);
  }

  async release(id: string): Promise<void> {
    await this.pool.query('UPDATE dr_charges SET claimed_until = NULL WHERE id = $1', [id]);
  }

  async markStalePending(before: Date): Promise<Charge[]> {
    const r = await this.pool.query<Row>(
      `UPDATE dr_charges SET state = 'push_unknown', updated_at = now()
        WHERE state = 'pending' AND push_started_at < $1
        RETURNING *`,
      [before],
    );
    return r.rows.map(toCharge);
  }

  async appendAudit(e: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO dr_audit (charge_id, checkout_request_id, kind, event, from_state, to_state, raw_payload, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        e.chargeId,
        e.checkoutRequestId,
        e.kind,
        e.event === null ? null : JSON.stringify(e.event),
        e.fromState,
        e.toState,
        e.rawPayload,
        e.at,
      ],
    );
  }
}
