-- Migration 0002 — whole-sale price adjustment.
--
-- A signed adjustment lets the counter set any final amount (a discount when
-- negative, a surcharge/round-up when positive). It sits on the document header,
-- reconciling the computed line totals to the price actually charged. The
-- approving user is recorded for the audit trail.

ALTER TABLE documents ADD COLUMN sale_adjustment_paisa INTEGER NOT NULL DEFAULT 0;
