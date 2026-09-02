-- Migration 0004 — offline licensing / 7-day trial state.
--
-- A single row holds the trial start, the activated license code (if any), and
-- a monotonic high-water mark used to detect system-clock rollback. Status
-- (TRIAL/GRACE/LICENSED/EXPIRED) is derived at runtime, not stored.

CREATE TABLE license (
  id               INTEGER PRIMARY KEY CHECK (id = 1), -- single row
  machine_id       TEXT NOT NULL,
  trial_start      TEXT NOT NULL,                       -- ISO, set on first boot
  license_code     TEXT,                                -- activated code, null during trial
  high_water_mark  TEXT NOT NULL,                       -- latest date ever seen (anti-rollback)
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
