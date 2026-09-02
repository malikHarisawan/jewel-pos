-- Migration 0003 — Karigar (goldsmith) job cards & wastage reconciliation.
--
-- A job is one issue→receive cycle: you hand a karigar metal (weight out), they
-- return finished pieces (weight in). The difference is wastage. If actual loss
-- exceeds the agreed wastage %, the job is flagged — that gap is unaccounted gold.
--
-- Metal flow stays on the append-only ledger: issuing posts a KARIGAR_ISSUE
-- movement out of a per-purity "karigar raw metal" lot item; receiving creates
-- the finished items and posts their intake. A running metal account per karigar
-- is derived from the jobs (issued − received, in net mg).

CREATE TABLE karigar_jobs (
  id                  INTEGER PRIMARY KEY,
  job_number          TEXT UNIQUE,                 -- 'JOB-2026-0001'
  karigar_party_id    INTEGER NOT NULL REFERENCES parties(id),
  purity_id           INTEGER NOT NULL REFERENCES purities(id),
  status              TEXT NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN','RECEIVED','CANCELLED')),
  -- issue
  issued_gross_mg     INTEGER NOT NULL CHECK (issued_gross_mg > 0),
  issued_net_mg       INTEGER NOT NULL CHECK (issued_net_mg > 0),
  allowed_wastage_bp  INTEGER NOT NULL DEFAULT 0 CHECK (allowed_wastage_bp >= 0),
  labour_rate_paisa   INTEGER NOT NULL DEFAULT 0, -- agreed making/labour (paisa per gram)
  issued_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  issued_by           INTEGER NOT NULL REFERENCES users(id),
  issue_movement_id   INTEGER REFERENCES stock_movements(id),
  -- receive (null until received)
  received_net_mg     INTEGER,                     -- total net weight of finished pieces
  actual_wastage_mg   INTEGER,                     -- issued_net - received_net
  over_tolerance      INTEGER NOT NULL DEFAULT 0 CHECK (over_tolerance IN (0,1)),
  labour_paid_paisa   INTEGER NOT NULL DEFAULT 0,
  received_at         TEXT,
  received_by         INTEGER REFERENCES users(id),
  notes               TEXT
);
CREATE INDEX ix_karigar_jobs_karigar ON karigar_jobs(karigar_party_id, status);
CREATE INDEX ix_karigar_jobs_status ON karigar_jobs(status);

-- Finished items produced by a job (links a job to the items it created).
CREATE TABLE karigar_job_items (
  id       INTEGER PRIMARY KEY,
  job_id   INTEGER NOT NULL REFERENCES karigar_jobs(id),
  item_id  INTEGER NOT NULL REFERENCES items(id)
);
CREATE INDEX ix_karigar_job_items_job ON karigar_job_items(job_id);

-- Document sequence for job numbers.
INSERT INTO doc_sequences (doc_type, fiscal_year, next_no, prefix) VALUES
  ('KARIGAR_JOB', 2026, 1, 'JOB');
