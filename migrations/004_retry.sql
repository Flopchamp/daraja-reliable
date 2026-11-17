-- chargeAgain(): a deliberate re-push after an ambiguous outcome is a NEW charge row, not a
-- mutation of the old one. The old prompt may still be live and may still be paid, and its
-- CheckoutRequestID must stay bound to the row it belongs to. `root_id` ties the rows of one
-- logical payment together (NULL for an ordinary charge); `attempt` orders them.
ALTER TABLE dr_charges ADD COLUMN IF NOT EXISTS root_id uuid REFERENCES dr_charges(id);

CREATE INDEX IF NOT EXISTS dr_charges_root_idx
  ON dr_charges (root_id) WHERE root_id IS NOT NULL;
