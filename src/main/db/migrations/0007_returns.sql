-- Migration 0007 — sale returns.
--
-- The schema already anticipated returns (SALE_RETURN doc type, RETURN line
-- kind, SALE_RETURN_IN movement, and a doc_sequences row for 2026). Two gaps
-- stopped them working in practice:
--
-- 1. Document numbers are issued per fiscal year, but only 2026 rows were
--    seeded. On 1 January 2027 EVERY document — sale or return — would fail
--    with "no sequence for ...". issueDocNumber now creates a missing year on
--    demand, so this is belt-and-braces for the years we can name today.
--
-- 2. A return has to point at the bill it reverses, so a bill can show what was
--    given back and the same line cannot be returned twice.

-- OR IGNORE, not ON CONFLICT: after an INSERT...SELECT, SQLite cannot tell a
-- conflict target apart from the select's own clauses, so the upsert form is a
-- syntax error here.
INSERT OR IGNORE INTO doc_sequences (doc_type, fiscal_year, next_no, prefix)
SELECT t.doc_type, y.fiscal_year, 1, t.prefix
FROM (SELECT 'SALE_INVOICE' doc_type, 'INV' prefix
      UNION ALL SELECT 'PURCHASE', 'PUR'
      UNION ALL SELECT 'SALE_RETURN', 'RET') t
CROSS JOIN (SELECT 2027 fiscal_year UNION ALL SELECT 2028
            UNION ALL SELECT 2029 UNION ALL SELECT 2030) y;

-- Which sale this return reverses. Nullable because the column is added to a
-- table that already holds sales (a sale reverses nothing).
ALTER TABLE documents ADD COLUMN returns_document_id INTEGER REFERENCES documents(id);

CREATE INDEX ix_documents_returns ON documents(returns_document_id);

-- Which original line a RETURN line gives back. Lets the register show the
-- remaining returnable quantity per line instead of per bill.
ALTER TABLE document_lines ADD COLUMN returns_line_id INTEGER REFERENCES document_lines(id);

CREATE INDEX ix_doc_lines_returns ON document_lines(returns_line_id);
