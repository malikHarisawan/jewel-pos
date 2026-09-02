-- Migration 0001 — initial schema, triggers, and seed data.
-- Hand-authored (not drizzle-kit generated) because the ledger's correctness
-- rests on triggers and CHECK constraints the generator does not emit.
--
-- Conventions: money = *_paisa (int), weight = *_mg (int), stones = *_carat_c
-- (carat*100), percent = *_bp (basis points). No REAL in any money/weight path.
-- Timestamps are ISO-8601 UTC TEXT.

-- ===========================================================================
-- Users
-- ===========================================================================
CREATE TABLE users (
  id           INTEGER PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  pin_hash     TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('OWNER','MANAGER','SALESMAN')),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ===========================================================================
-- Category axes — one lookup table per axis (not EAV)
-- ===========================================================================
CREATE TABLE product_types (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE metals (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE stone_types (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE making_types (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE occasions (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
);

-- Purity belongs to a metal and carries fineness; rates key on it.
CREATE TABLE purities (
  id                  INTEGER PRIMARY KEY,
  metal_id            INTEGER NOT NULL REFERENCES metals(id),
  label               TEXT NOT NULL,
  fineness_millesimal INTEGER NOT NULL CHECK (fineness_millesimal BETWEEN 1 AND 1000),
  is_active           INTEGER NOT NULL DEFAULT 1,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (metal_id, label)
);

-- ===========================================================================
-- Locations (adjacency list)
-- ===========================================================================
CREATE TABLE locations (
  id        INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES locations(id),
  kind      TEXT NOT NULL CHECK (kind IN ('BRANCH','COUNTER','SHOWCASE','TRAY')),
  name      TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (parent_id, name)
);
CREATE INDEX ix_locations_parent ON locations(parent_id);

-- ===========================================================================
-- Parties
-- ===========================================================================
CREATE TABLE parties (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('CUSTOMER','SUPPLIER','KARIGAR')),
  name       TEXT NOT NULL,
  phone      TEXT,
  cnic       TEXT,
  address    TEXT,
  notes      TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER NOT NULL REFERENCES users(id)
);
CREATE INDEX ix_parties_kind_name ON parties(kind, name);
CREATE INDEX ix_parties_phone ON parties(phone);

-- ===========================================================================
-- Items — both tracking modes in one table
-- ===========================================================================
CREATE TABLE items (
  id              INTEGER PRIMARY KEY,
  tracking_mode   TEXT NOT NULL CHECK (tracking_mode IN ('ITEM','LOT')),
  tag_number      TEXT UNIQUE,
  name            TEXT NOT NULL,
  product_type_id INTEGER NOT NULL REFERENCES product_types(id),
  metal_id        INTEGER NOT NULL REFERENCES metals(id),
  purity_id       INTEGER NOT NULL REFERENCES purities(id),
  stone_type_id   INTEGER NOT NULL REFERENCES stone_types(id),
  making_type_id  INTEGER NOT NULL REFERENCES making_types(id),
  occasion_id     INTEGER REFERENCES occasions(id),
  origin_kind     TEXT NOT NULL CHECK (origin_kind IN ('SUPPLIER','KARIGAR','IN_HOUSE','OLD_GOLD')),
  source_party_id INTEGER REFERENCES parties(id),
  gross_mg        INTEGER NOT NULL CHECK (gross_mg >= 0),
  less_mg         INTEGER NOT NULL DEFAULT 0 CHECK (less_mg >= 0),
  net_mg          INTEGER NOT NULL CHECK (net_mg = gross_mg - less_mg),
  touch_bp        INTEGER CHECK (touch_bp IS NULL OR touch_bp BETWEEN 1 AND 10000),
  wastage_bp      INTEGER NOT NULL DEFAULT 0 CHECK (wastage_bp >= 0),
  making_mode     TEXT NOT NULL DEFAULT 'PER_GRAM'
                  CHECK (making_mode IN ('PER_GRAM','FIXED','PCT_OF_METAL')),
  making_rate_paisa     INTEGER NOT NULL DEFAULT 0,
  hallmark_number       TEXT,
  hallmark_charge_paisa INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'IN_STOCK'
                  CHECK (status IN ('IN_STOCK','ON_APPROVAL','SOLD','WITH_KARIGAR','MELTED')),
  location_id     INTEGER NOT NULL REFERENCES locations(id),
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by      INTEGER NOT NULL REFERENCES users(id)
);
CREATE INDEX ix_items_status ON items(status);
CREATE INDEX ix_items_axes ON items(metal_id, purity_id, product_type_id);
CREATE INDEX ix_items_location ON items(location_id);

-- Cost basis: separate table so "owner-only" is structural, not a field list.
CREATE TABLE item_costs (
  item_id                    INTEGER PRIMARY KEY REFERENCES items(id),
  intake_rate_paisa_per_gram INTEGER,
  labour_paid_paisa          INTEGER NOT NULL DEFAULT 0,
  stone_cost_paisa           INTEGER NOT NULL DEFAULT 0,
  other_cost_paisa           INTEGER NOT NULL DEFAULT 0,
  landed_cost_paisa          INTEGER NOT NULL DEFAULT 0,
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by                 INTEGER NOT NULL REFERENCES users(id)
);

CREATE TABLE item_stones (
  id                   INTEGER PRIMARY KEY,
  item_id              INTEGER NOT NULL REFERENCES items(id),
  stone_type_id        INTEGER NOT NULL REFERENCES stone_types(id),
  stone_count          INTEGER NOT NULL CHECK (stone_count > 0),
  total_carat_c        INTEGER NOT NULL CHECK (total_carat_c > 0),
  rate_paisa_per_carat INTEGER NOT NULL DEFAULT 0,
  clarity              TEXT,
  notes                TEXT
);
CREATE INDEX ix_item_stones_item ON item_stones(item_id);

CREATE TABLE item_photos (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items(id),
  file_path  TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ix_item_photos_item ON item_photos(item_id);

-- ===========================================================================
-- Metal rates — append-only history
-- ===========================================================================
CREATE TABLE metal_rates (
  id                  INTEGER PRIMARY KEY,
  purity_id           INTEGER NOT NULL REFERENCES purities(id),
  rate_paisa_per_gram INTEGER NOT NULL CHECK (rate_paisa_per_gram > 0),
  entered_value_paisa INTEGER NOT NULL,
  entered_basis       TEXT NOT NULL CHECK (entered_basis IN ('PER_GRAM','PER_TOLA','PER_10G')),
  effective_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  entered_by          INTEGER NOT NULL REFERENCES users(id)
);
CREATE INDEX ix_metal_rates_lookup ON metal_rates(purity_id, effective_at DESC);

-- ===========================================================================
-- Documents (unified header) + lines
-- ===========================================================================
CREATE TABLE documents (
  id            INTEGER PRIMARY KEY,
  doc_type      TEXT NOT NULL CHECK (doc_type IN
                 ('SALE_INVOICE','PURCHASE','SALE_RETURN',
                  'APPROVAL_MEMO','KARIGAR_VOUCHER','TRANSFER_NOTE','STOCKTAKE')),
  doc_number    TEXT UNIQUE,
  status        TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','FINAL','CANCELLED')),
  party_id      INTEGER REFERENCES parties(id),
  doc_date      TEXT NOT NULL,
  metal_value_paisa    INTEGER NOT NULL DEFAULT 0,
  making_value_paisa   INTEGER NOT NULL DEFAULT 0,
  wastage_value_paisa  INTEGER NOT NULL DEFAULT 0,
  stone_value_paisa    INTEGER NOT NULL DEFAULT 0,
  hallmark_value_paisa INTEGER NOT NULL DEFAULT 0,
  exchange_value_paisa INTEGER NOT NULL DEFAULT 0,
  discount_paisa       INTEGER NOT NULL DEFAULT 0,
  tax_paisa            INTEGER NOT NULL DEFAULT 0,
  rounding_paisa       INTEGER NOT NULL DEFAULT 0,
  grand_total_paisa    INTEGER NOT NULL DEFAULT 0,
  discount_approved_by INTEGER REFERENCES users(id),
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  finalized_at  TEXT,
  finalized_by  INTEGER REFERENCES users(id)
);
CREATE INDEX ix_documents_type_date ON documents(doc_type, doc_date);
CREATE INDEX ix_documents_party ON documents(party_id);

CREATE TABLE document_lines (
  id            INTEGER PRIMARY KEY,
  document_id   INTEGER NOT NULL REFERENCES documents(id),
  line_no       INTEGER NOT NULL,
  line_kind     TEXT NOT NULL CHECK (line_kind IN ('ITEM','LOT_WEIGHT','OLD_GOLD_EXCHANGE','RETURN')),
  item_id       INTEGER REFERENCES items(id),
  description   TEXT NOT NULL,
  pieces        INTEGER NOT NULL,
  gross_mg      INTEGER NOT NULL,
  less_mg       INTEGER NOT NULL DEFAULT 0,
  net_mg        INTEGER NOT NULL CHECK (net_mg = gross_mg - less_mg),
  touch_bp      INTEGER,
  purity_id     INTEGER NOT NULL REFERENCES purities(id),
  metal_rate_id       INTEGER NOT NULL REFERENCES metal_rates(id),
  rate_paisa_per_gram INTEGER NOT NULL,
  metal_value_paisa     INTEGER NOT NULL,
  making_mode           TEXT CHECK (making_mode IS NULL OR making_mode IN ('PER_GRAM','FIXED','PCT_OF_METAL')),
  making_rate_paisa     INTEGER NOT NULL DEFAULT 0,
  making_value_paisa    INTEGER NOT NULL DEFAULT 0,
  wastage_bp            INTEGER NOT NULL DEFAULT 0,
  wastage_value_paisa   INTEGER NOT NULL DEFAULT 0,
  stone_value_paisa     INTEGER NOT NULL DEFAULT 0,
  hallmark_charge_paisa INTEGER NOT NULL DEFAULT 0,
  discount_paisa        INTEGER NOT NULL DEFAULT 0,
  tax_bp                INTEGER NOT NULL DEFAULT 0,
  taxable_base_paisa    INTEGER NOT NULL DEFAULT 0,
  tax_paisa             INTEGER NOT NULL DEFAULT 0,
  line_total_paisa      INTEGER NOT NULL,
  return_of_line_id     INTEGER REFERENCES document_lines(id),
  UNIQUE (document_id, line_no)
);
CREATE INDEX ix_doc_lines_doc ON document_lines(document_id);
CREATE INDEX ix_doc_lines_item ON document_lines(item_id);

CREATE TABLE document_line_stones (
  id                   INTEGER PRIMARY KEY,
  line_id              INTEGER NOT NULL REFERENCES document_lines(id),
  stone_type_id        INTEGER NOT NULL REFERENCES stone_types(id),
  stone_count          INTEGER NOT NULL,
  total_carat_c        INTEGER NOT NULL,
  rate_paisa_per_carat INTEGER NOT NULL,
  value_paisa          INTEGER NOT NULL
);
CREATE INDEX ix_doc_line_stones_line ON document_line_stones(line_id);

-- ===========================================================================
-- Payments
-- ===========================================================================
CREATE TABLE payments (
  id           INTEGER PRIMARY KEY,
  document_id  INTEGER NOT NULL REFERENCES documents(id),
  method       TEXT NOT NULL CHECK (method IN ('CASH','BANK','CARD','CREDIT')),
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa != 0),
  bank_ref     TEXT,
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  received_by  INTEGER NOT NULL REFERENCES users(id)
);
CREATE INDEX ix_payments_doc ON payments(document_id);

-- ===========================================================================
-- Stock movement ledger — the centrepiece
-- ===========================================================================
CREATE TABLE stock_movements (
  id               INTEGER PRIMARY KEY,
  movement_type    TEXT NOT NULL CHECK (movement_type IN (
                     'OPENING','PURCHASE_IN','SALE_OUT','SALE_RETURN_IN','EXCHANGE_IN','ADJUSTMENT',
                     'KARIGAR_ISSUE','KARIGAR_RECEIVE','APPROVAL_OUT','APPROVAL_IN',
                     'TRANSFER_OUT','TRANSFER_IN','STOCKTAKE_ADJ')),
  item_id          INTEGER NOT NULL REFERENCES items(id),
  location_id      INTEGER NOT NULL REFERENCES locations(id),
  pieces_delta     INTEGER NOT NULL,
  gross_mg_delta   INTEGER NOT NULL,
  net_mg_delta     INTEGER NOT NULL,
  document_id      INTEGER REFERENCES documents(id),
  document_line_id INTEGER REFERENCES document_lines(id),
  party_id         INTEGER REFERENCES parties(id),
  transfer_group   TEXT,
  reason_code      TEXT CHECK (reason_code IS NULL OR reason_code IN
                     ('DAMAGE','THEFT','WEIGHING_ERROR','DATA_ENTRY_ERROR',
                      'MELT','POLISH_LOSS','STOCKTAKE','OTHER')),
  reverses_movement_id INTEGER REFERENCES stock_movements(id),
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by       INTEGER NOT NULL REFERENCES users(id),
  CHECK (
    (movement_type IN ('OPENING','PURCHASE_IN','SALE_RETURN_IN','EXCHANGE_IN',
                       'KARIGAR_RECEIVE','APPROVAL_IN','TRANSFER_IN')
       AND pieces_delta >= 0 AND net_mg_delta >= 0 AND gross_mg_delta >= 0)
    OR (movement_type IN ('SALE_OUT','KARIGAR_ISSUE','APPROVAL_OUT','TRANSFER_OUT')
       AND pieces_delta <= 0 AND net_mg_delta <= 0 AND gross_mg_delta <= 0)
    OR (movement_type IN ('ADJUSTMENT','STOCKTAKE_ADJ'))
  ),
  CHECK (movement_type NOT IN ('ADJUSTMENT','STOCKTAKE_ADJ') OR reason_code IS NOT NULL)
);
CREATE INDEX ix_mov_item ON stock_movements(item_id, id);
CREATE INDEX ix_mov_location ON stock_movements(location_id, item_id);
CREATE INDEX ix_mov_doc ON stock_movements(document_id);
CREATE INDEX ix_mov_type_dt ON stock_movements(movement_type, created_at);

-- Materialized dual-unit balance, maintained by trigger (safe: ledger is append-only).
CREATE TABLE item_balances (
  item_id          INTEGER PRIMARY KEY REFERENCES items(id),
  pieces           INTEGER NOT NULL DEFAULT 0,
  gross_mg         INTEGER NOT NULL DEFAULT 0,
  net_mg           INTEGER NOT NULL DEFAULT 0,
  last_movement_id INTEGER NOT NULL
);

-- ===========================================================================
-- Rate locks for open bills
-- ===========================================================================
CREATE TABLE document_rate_locks (
  document_id   INTEGER NOT NULL REFERENCES documents(id),
  purity_id     INTEGER NOT NULL REFERENCES purities(id),
  metal_rate_id INTEGER NOT NULL REFERENCES metal_rates(id),
  locked_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (document_id, purity_id)
);

-- ===========================================================================
-- Audit log — hash-chained (chain computed in the app layer)
-- ===========================================================================
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  prev_hash    TEXT NOT NULL,
  row_hash     TEXT NOT NULL UNIQUE,
  table_name   TEXT NOT NULL,
  row_pk       INTEGER NOT NULL,
  action       TEXT NOT NULL CHECK (action IN
                 ('INSERT','UPDATE','DELETE','LOGIN','OVERRIDE','FINALIZE','REBUILD')),
  changes_json TEXT NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ix_audit_table_pk ON audit_log(table_name, row_pk);

-- ===========================================================================
-- Settings & document numbering
-- ===========================================================================
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id)
);

CREATE TABLE doc_sequences (
  doc_type    TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  next_no     INTEGER NOT NULL DEFAULT 1,
  prefix      TEXT NOT NULL,
  PRIMARY KEY (doc_type, fiscal_year)
);

-- ===========================================================================
-- Triggers
-- ===========================================================================

-- Immutability: block UPDATE/DELETE on append-only tables.
CREATE TRIGGER trg_mov_no_update BEFORE UPDATE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;
CREATE TRIGGER trg_mov_no_delete BEFORE DELETE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;

CREATE TRIGGER trg_rate_no_update BEFORE UPDATE ON metal_rates
BEGIN SELECT RAISE(ABORT, 'metal_rates is append-only'); END;
CREATE TRIGGER trg_rate_no_delete BEFORE DELETE ON metal_rates
BEGIN SELECT RAISE(ABORT, 'metal_rates is append-only'); END;

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- ITEM-mode pieces discipline + sold/melted lock (BEFORE INSERT).
CREATE TRIGGER trg_mov_item_guard BEFORE INSERT ON stock_movements
WHEN (SELECT tracking_mode FROM items WHERE id = NEW.item_id) = 'ITEM'
BEGIN
  SELECT CASE
    WHEN abs(NEW.pieces_delta) != 1
      THEN RAISE(ABORT, 'ITEM-mode movement must move exactly one piece')
    WHEN (SELECT status FROM items WHERE id = NEW.item_id) IN ('SOLD','MELTED')
         AND NEW.movement_type != 'SALE_RETURN_IN'
      THEN RAISE(ABORT, 'item is sold or melted and cannot move')
  END;
END;

-- Balance maintenance + negative-balance guard in ONE trigger program.
-- The upsert and the RAISE must share a trigger body: a standalone guard in a
-- second AFTER-INSERT trigger does NOT abort reliably against the row the first
-- trigger just wrote. Aborting here also rolls back the upsert, so the balance
-- stays consistent with the (rejected) movement.
CREATE TRIGGER trg_mov_balance AFTER INSERT ON stock_movements
BEGIN
  INSERT INTO item_balances (item_id, pieces, gross_mg, net_mg, last_movement_id)
  VALUES (NEW.item_id, NEW.pieces_delta, NEW.gross_mg_delta, NEW.net_mg_delta, NEW.id)
  ON CONFLICT(item_id) DO UPDATE SET
    pieces   = pieces   + NEW.pieces_delta,
    gross_mg = gross_mg + NEW.gross_mg_delta,
    net_mg   = net_mg   + NEW.net_mg_delta,
    last_movement_id = NEW.id;
  SELECT RAISE(ABORT, 'insufficient stock')
  FROM item_balances
  WHERE item_id = NEW.item_id AND (pieces < 0 OR net_mg < 0 OR gross_mg < 0);
END;

-- FINAL documents are immutable (allow DRAFT->FINAL/CANCELLED transitions only).
CREATE TRIGGER trg_doc_final_lock BEFORE UPDATE ON documents
WHEN OLD.status = 'FINAL'
BEGIN SELECT RAISE(ABORT, 'finalized document is immutable'); END;

CREATE TRIGGER trg_doc_line_final_lock_upd BEFORE UPDATE ON document_lines
WHEN (SELECT status FROM documents WHERE id = OLD.document_id) = 'FINAL'
BEGIN SELECT RAISE(ABORT, 'lines of a finalized document are immutable'); END;
CREATE TRIGGER trg_doc_line_final_lock_del BEFORE DELETE ON document_lines
WHEN (SELECT status FROM documents WHERE id = OLD.document_id) = 'FINAL'
BEGIN SELECT RAISE(ABORT, 'lines of a finalized document are immutable'); END;

-- ===========================================================================
-- Seed data
-- ===========================================================================
INSERT INTO product_types (name, sort_order) VALUES
  ('Ring',1),('Bangle / Kangan',2),('Necklace / Set',3),('Earrings / Jhumka',4),
  ('Chain',5),('Locket / Pendant',6),('Bracelet',7),('Payal',8),('Nose Pin',9),
  ('Tikka',10),('Coin / Bar',11);

INSERT INTO metals (name, sort_order) VALUES
  ('Gold',1),('Silver',2),('Platinum',3),('Artificial',4);

INSERT INTO purities (metal_id, label, fineness_millesimal, sort_order)
SELECT id, '24K / 999', 999, 1 FROM metals WHERE name='Gold'
UNION ALL SELECT id, '22K / 916', 916, 2 FROM metals WHERE name='Gold'
UNION ALL SELECT id, '21K / 875', 875, 3 FROM metals WHERE name='Gold'
UNION ALL SELECT id, '18K / 750', 750, 4 FROM metals WHERE name='Gold'
UNION ALL SELECT id, 'Silver 925', 925, 1 FROM metals WHERE name='Silver'
UNION ALL SELECT id, 'Platinum 950', 950, 1 FROM metals WHERE name='Platinum';

INSERT INTO stone_types (name, sort_order) VALUES
  ('Plain',1),('Kundan',2),('Polki',3),('Diamond',4),('Gemstone',5),('Pearl',6);

INSERT INTO making_types (name, sort_order) VALUES
  ('Handmade',1),('Machine-made',2),('Casting',3),('Imported',4);

INSERT INTO occasions (name, sort_order) VALUES
  ('Bridal',1),('Daily Wear',2),('Kids',3),('Gents',4);

INSERT INTO locations (parent_id, kind, name) VALUES (NULL, 'BRANCH', 'Main Shop');

INSERT INTO doc_sequences (doc_type, fiscal_year, next_no, prefix) VALUES
  ('SALE_INVOICE', 2026, 1, 'INV'),
  ('PURCHASE',     2026, 1, 'PUR'),
  ('SALE_RETURN',  2026, 1, 'RET');

INSERT INTO app_settings (key, value) VALUES
  ('shop_name', 'My Jewellers'),
  ('tola_mg', '11664'),
  ('invoice_round_to', '100'),
  ('tax_rate_bp', '300'),
  ('tax_base', 'TOTAL_MINUS_METAL'),
  ('idle_lock_minutes', '10');
