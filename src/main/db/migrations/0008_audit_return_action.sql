-- Migration 0008 — allow RETURN in the audit trail.
--
-- audit_log.action carries a CHECK list that predates returns, so recording one
-- would abort at runtime (and take the whole return transaction with it).
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt.
--
-- audit_log is hash-chained and guarded by append-only triggers. Those triggers
-- are attached to the OLD table and die with it, so they are recreated below —
-- without this the audit trail would silently become editable.
--
-- Rows are copied verbatim: prev_hash/row_hash are preserved exactly, so the
-- existing chain still verifies after the rebuild.

DROP TRIGGER IF EXISTS trg_audit_no_update;
DROP TRIGGER IF EXISTS trg_audit_no_delete;

ALTER TABLE audit_log RENAME TO audit_log_old;

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  prev_hash    TEXT NOT NULL,
  row_hash     TEXT NOT NULL UNIQUE,
  table_name   TEXT NOT NULL,
  row_pk       INTEGER NOT NULL,
  action       TEXT NOT NULL CHECK (action IN
                 ('INSERT','UPDATE','DELETE','LOGIN','OVERRIDE','FINALIZE','RETURN','REBUILD')),
  changes_json TEXT NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO audit_log (id, prev_hash, row_hash, table_name, row_pk, action, changes_json, user_id, at)
SELECT id, prev_hash, row_hash, table_name, row_pk, action, changes_json, user_id, at
FROM audit_log_old;

DROP TABLE audit_log_old;

CREATE INDEX ix_audit_table_pk ON audit_log(table_name, row_pk);

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
