-- Migration 0005 — discount authority limits.
--
-- The POS sends a signed `sale_adjustment_paisa` to set the final price. Without
-- a ceiling, any cashier can discount a sale to nothing. These settings cap how
-- far a SALESMAN may cut a bill on their own; beyond the cap the sale is refused
-- and needs an OWNER/MANAGER to ring it up. Managers/owners are capped too, at a
-- higher bound, so a fat-finger keystroke cannot zero out a large invoice.
--
-- Percent values are whole percent of the computed (pre-adjustment) total.

INSERT INTO app_settings (key, value) VALUES
  ('max_discount_pct_salesman', '5'),
  ('max_discount_pct_manager', '20')
ON CONFLICT(key) DO NOTHING;
