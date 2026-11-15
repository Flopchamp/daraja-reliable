-- Transactional outbox. A row is written in the SAME statement that moves a charge to
-- settled / failed / unresolved (see PostgresStore.transition), so a crash between commit
-- and "tell the application" cannot lose the event. Delivery is at-least-once.
CREATE TABLE IF NOT EXISTS dr_outbox (
  id            bigserial PRIMARY KEY,
  charge_id     uuid NOT NULL REFERENCES dr_charges(id),
  type          text NOT NULL CHECK (type IN ('settled','failed','unresolved','discrepancy')),
  payload       jsonb,
  attempts      integer NOT NULL DEFAULT 0,
  claimed_until timestamptz,
  delivered_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dr_outbox_pending_idx
  ON dr_outbox (id) WHERE delivered_at IS NULL;
