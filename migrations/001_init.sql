CREATE TABLE IF NOT EXISTS dr_charges (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key     text NOT NULL,
  fingerprint         text NOT NULL,
  phone               text NOT NULL,
  amount              integer NOT NULL CHECK (amount > 0),
  account_ref         text NOT NULL,
  state               text NOT NULL CHECK (state IN
                        ('pending','push_unknown','awaiting_callback','unresolved','settled','failed')),
  checkout_request_id text,
  attempt             integer NOT NULL DEFAULT 1,
  query_failures      integer NOT NULL DEFAULT 0,
  push_started_at     timestamptz NOT NULL DEFAULT now(),
  claimed_until       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dr_charges_key_unique UNIQUE (idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS dr_charges_checkout_uq
  ON dr_charges (checkout_request_id) WHERE checkout_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS dr_charges_sweep_idx
  ON dr_charges (push_started_at)
  WHERE state IN ('awaiting_callback','push_unknown');

CREATE TABLE IF NOT EXISTS dr_audit (
  id                  bigserial PRIMARY KEY,
  charge_id           uuid REFERENCES dr_charges(id),
  checkout_request_id text,
  kind                text NOT NULL,
  event               jsonb,
  from_state          text,
  to_state            text,
  raw_payload         text,
  at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dr_audit_charge_idx ON dr_audit (charge_id, at);
