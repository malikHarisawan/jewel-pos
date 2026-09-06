-- Migration 0010 — tray and startup preferences.
--
-- A POS is open all day. Closing the window should put the app in the tray
-- rather than shutting the till down, and the shop should not have to remember
-- to launch it every morning. Both are preferences, not hardcoded behaviour:
-- a back-office PC that only runs reports wants neither.
--
-- Stored as '1'/'0' strings to match every other row in app_settings.
--
-- Defaults: close-to-tray ON (the till stays live and the window is one click
-- away), launch-at-login OFF (installing software must never silently add
-- itself to a machine's startup — the shop opts in).

INSERT INTO app_settings (key, value) VALUES
  ('close_to_tray', '1'),
  ('launch_at_startup', '0')
ON CONFLICT(key) DO NOTHING;
