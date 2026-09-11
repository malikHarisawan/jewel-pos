# Sample sheets for the importer

Files to try **Settings → Import from a spreadsheet** with, without touching a
real shop's data.

Regenerate them any time with:

```
npm run samples
```

They are generated from `scripts/make-sample-sheets.mjs` rather than committed
as binaries, so the fixture data can be read and edited as code. What each one
is for, and what should happen:

| File | What it is | Expect |
|---|---|---|
| `1-typical-stock.xlsx` | An ordinary shop stock list — headers like `Gross Wt (gms)`, money written `1,200`, a blank row in the middle | 9 rows, all ready. Columns matched with no manual help |
| `2-names-only.xlsx` | Just item names, no weights | 6 rows ready, each warning that it came in at 0 g |
| `3-names-and-prices.xlsx` | Names plus a `Sale Price` column the importer has no field for | 4 rows ready; the price column is ignored |
| `4-weights-in-tola.xlsx` | Weights kept in tola | Set **Weights are in → Tola**. 1 tola becomes 11.664 g |
| `5-with-mistakes.xlsx` | One row per failure mode, two good rows | 2 ready, the rest explained. Pressing Import writes nothing until the bad rows are excluded |
| `6-multiple-sheets.xlsx` | Gold / Silver / Notes | The sheet picker appears. `Notes` has no usable columns and says so |
| `7-unknown-headers.xlsx` | Headers called `Col A`, `Col B`, `Col C` | Nothing auto-matches. Use **Check columns** to bind them by hand |
| `8-typical-stock.csv` | The same shape as #1, saved as CSV | Reads identically to the .xlsx |

## What the mistakes file covers

`5-with-mistakes.xlsx`, sheet **Stock**:

- net weight heavier than gross
- a product type that does not exist in the app
- a purity that does not exist
- a weight cell containing text
- the same tag on two rows (**both** are flagged, not just the second)
- a row with no name

Sheet **Metal Clash** holds the one error that needs a `Metal` column present:
a gold purity filed under Silver.

## A note on these being tests too

`tests/samples.test.ts` runs every file above and asserts the behaviour in the
table. If you change the importer and a sample stops behaving as described, that
test fails — the table cannot quietly go stale.
