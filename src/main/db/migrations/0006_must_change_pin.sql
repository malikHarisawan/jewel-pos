-- Migration 0006 — force a PIN change on first sign-in.
--
-- A fresh install seeds `owner` / `1234` so the shop can get in at all. Nothing
-- previously forced that default to be replaced, so a shipped machine could sit
-- on a published password forever. This flag makes the app demand a new PIN
-- before it will show any screen.
--
-- Existing installs default to 0: they are already running with PINs their
-- owner chose, and re-prompting them would be noise. Only accounts created
-- from here on (and the seeded owner) start with the flag set.

ALTER TABLE users ADD COLUMN must_change_pin INTEGER NOT NULL DEFAULT 0
  CHECK (must_change_pin IN (0,1));
