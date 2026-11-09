-- The M-Pesa receipt is a second dedupe key: one receipt can settle at most one charge.
ALTER TABLE dr_charges ADD COLUMN IF NOT EXISTS receipt text;

CREATE UNIQUE INDEX IF NOT EXISTS dr_charges_receipt_uq
  ON dr_charges (receipt) WHERE receipt IS NOT NULL;
