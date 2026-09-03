-- Migration 0009 — customer credit (udhaar) ledger.
--
-- CREDIT was already a selectable payment method, but nothing recorded WHO owed
-- the money: a sale could be rung up as credit and the debt simply vanished.
-- Half the jewellery trade here runs on udhaar, so this was a hole straight
-- through the books.
--
-- Like stock, the balance is a fold over an append-only ledger rather than a
-- stored number — the same discipline the rest of the app uses, so a balance
-- can always be explained by the rows that produced it.
--
-- Sign convention (from the SHOP's point of view):
--   positive amount = the party owes the shop more   (a credit sale)
--   negative amount = the party owes less            (a repayment, a refund)
-- So the running balance IS what they currently owe.

CREATE TABLE party_ledger (
  id           INTEGER PRIMARY KEY,
  party_id     INTEGER NOT NULL REFERENCES parties(id),
  entry_type   TEXT NOT NULL CHECK (entry_type IN
                 ('CREDIT_SALE','REPAYMENT','RETURN_CREDIT','OPENING','ADJUSTMENT')),
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa != 0),
  -- The sale/return this entry came from, when it came from one.
  document_id  INTEGER REFERENCES documents(id),
  -- How a repayment arrived. Null for entries that moved no cash.
  method       TEXT CHECK (method IS NULL OR method IN ('CASH','BANK','CARD')),
  notes        TEXT,
  entry_date   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by   INTEGER NOT NULL REFERENCES users(id)
);

CREATE INDEX ix_party_ledger_party ON party_ledger(party_id, entry_date);
CREATE INDEX ix_party_ledger_doc ON party_ledger(document_id);

-- Append-only, exactly like stock_movements and audit_log. A wrong entry is
-- corrected by posting an opposing ADJUSTMENT, never by editing history.
CREATE TRIGGER trg_party_ledger_no_update BEFORE UPDATE ON party_ledger
BEGIN SELECT RAISE(ABORT, 'party_ledger is append-only'); END;
CREATE TRIGGER trg_party_ledger_no_delete BEFORE DELETE ON party_ledger
BEGIN SELECT RAISE(ABORT, 'party_ledger is append-only'); END;
