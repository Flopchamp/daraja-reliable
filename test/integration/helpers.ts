import pg from 'pg';
import { migrate, PostgresStore } from '../../src/pg-store.js';

/** Integration tests need a real Postgres: row locking is the thing under test. */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Start Postgres (see README) and e.g. export DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres',
    );
  }
  return url;
}

export async function freshDb(): Promise<{ pool: pg.Pool; store: PostgresStore }> {
  const pool = new pg.Pool({ connectionString: databaseUrl(), max: 20 });
  await migrate(pool);
  await pool.query('TRUNCATE dr_audit, dr_charges RESTART IDENTITY CASCADE');
  return { pool, store: new PostgresStore(pool) };
}

export const req = { phone: '254712345678', amount: 1500, accountRef: 'INV-1' };
