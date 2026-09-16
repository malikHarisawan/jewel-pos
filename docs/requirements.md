# Jewel POS — Functional Requirements (v1.0.0)

Offline-first inventory and point-of-sale for a Pakistani jewellery shop.
Single PC, no internet required, no server.

Status of every requirement below is one of:

- **Done** — implemented and covered by automated tests.
- **Not in v1** — deliberately out of scope for this release.

---

## 1. Sign-in and users

| # | Requirement | Status |
|---|---|---|
| 1.1 | Three roles: Owner, Manager, Salesman | Done |
| 1.2 | Sign in with username + PIN; PINs stored argon2id-hashed, never in clear | Done |
| 1.3 | Lock the account for 30s after 5 failed attempts | Done |
| 1.4 | Roles are enforced in the main process; the UI cannot claim a role | Done |
| 1.5 | A handed-out PIN (first install, or an owner reset) must be changed before the app opens | Done |
| 1.6 | Owner creates/disables users and resets PINs; the last active owner cannot be disabled | Done |
| 1.7 | Return to sign-in after a configurable idle period | Done |

**Role access**

| Screen | Owner | Manager | Salesman |
|---|:--:|:--:|:--:|
| Dashboard, Items, Stock, Rates, Sales, Udhaar, Karigar | ✅ | ✅ | — |
| POS (ring up a sale) | ✅ | ✅ | ✅ |
| Settings | ✅ | ✅ | — |
| Users, Discount limits, Backups | ✅ | — | — |

---

## 2. Licensing

| # | Requirement | Status |
|---|---|---|
| 2.1 | 7-day free trial from first launch | Done |
| 2.2 | 3-day grace period with a persistent warning | Done |
| 2.3 | Hard lock to an activation screen after that | Done |
| 2.4 | Activation is offline: shop reads their Machine ID, you send a signed code | Done |
| 2.5 | Codes are Ed25519-signed and bound to one machine; they cannot be forged or shared | Done |
| 2.6 | Rolling the system clock back is detected and locks the app | Done |
| 2.7 | Data is never touched by licensing — activating unlocks it instantly | Done |

---

## 3. Catalogue and items

| # | Requirement | Status |
|---|---|---|
| 3.1 | Two tracking modes: **Unique** (one tagged piece) and **Lot** (bulk by weight) | Done |
| 3.2 | Gross / Less / Net weights, with Less derived when not given | Done |
| 3.3 | Weights rejected if impossible (net greater than gross) | Done |
| 3.4 | Metal, purity, product type, stone type, making type, location | Done |
| 3.5 | Making charge per gram, fixed, or a percentage of metal value | Done |
| 3.6 | Wastage as basis points; hallmark charge per piece | Done |
| 3.7 | Search by name, tag or category | Done |
| 3.8 | Live price column at today's rate (never stored as a price) | Done |
| 3.9 | Photographs of pieces | Not in v1 |
| 3.10 | Printing barcode/tag labels | Done |

---

## 4. Stock

| # | Requirement | Status |
|---|---|---|
| 4.1 | All stock changes go through one append-only ledger | Done |
| 4.2 | Balances are folded from the ledger, never stored and edited | Done |
| 4.3 | Ledger rows cannot be updated or deleted (enforced by the database) | Done |
| 4.4 | Dual units tracked together: pieces and weight | Done |
| 4.5 | Opening stock, purchases in, adjustments with a reason code | Done |
| 4.6 | Mistakes are corrected by posting a reversal, never by editing | Done |
| 4.7 | Stock can never go negative (enforced by the database) | Done |
| 4.8 | A sold unique piece cannot move again unless it is returned | Done |
| 4.9 | Multiple branches / transfers between them | Not in v1 |

---

## 5. Rates

| # | Requirement | Status |
|---|---|---|
| 5.1 | Enter today's rate per purity | Done |
| 5.2 | Accept the rate in whatever unit the bazaar quotes: per gram, per tola, per 10g | Done |
| 5.3 | Store canonically as paisa per gram | Done |
| 5.4 | Rate history is append-only; a mistake is corrected by posting again | Done |
| 5.5 | Tola is configurable per shop (default 11.664 g) | Done |
| 5.6 | Every invoice locks the rate it was priced at, permanently | Done |
| 5.7 | A morning card prompts for today's rate when it has not been posted | Done |
| 5.8 | Post 24K and the other gold purities follow by fineness ratio | Done |
| 5.9 | An optional online source *suggests* a rate; the owner always confirms | Done |
| 5.10 | A rate moving more than a set % from the last one is queried before posting | Done |
| 5.11 | The POS warns when it is selling on a rate posted before today | Done |

---

## 6. Selling (POS)

| # | Requirement | Status |
|---|---|---|
| 6.1 | Scan a tag or type a name; Enter adds the top match | Done |
| 6.2 | F9 finalises the sale — keyboard-only operation | Done |
| 6.3 | Sell a whole unique piece, or any weight from a lot | Done |
| 6.4 | Take old gold in exchange, valued by weight × touch × rate, credited to the bill | Done |
| 6.5 | Old gold accumulates into a scrap lot in stock automatically | Done |
| 6.6 | Discount in rupees or percent, or type a custom final amount | Done |
| 6.7 | Discounts are capped per role; over the cap the sale is refused | Done |
| 6.8 | Split payment across cash / card / bank / credit | Done |
| 6.9 | Checkout is blocked until payments equal the payable exactly | Done |
| 6.10 | Attach a customer to the bill; a salesman can register a new one | Done |
| 6.11 | The whole sale is one transaction — no half-finished invoice can exist | Done |
| 6.12 | Gapless invoice numbering per fiscal year | Done |
| 6.13 | Tax with a configurable rate, and the FBR gold-exempt base | Done |
| 6.14 | Rounding to the nearest rupee, configurable | Done |

---

## 7. Sales register

| # | Requirement | Status |
|---|---|---|
| 7.1 | List every finalised bill, newest first | Done |
| 7.2 | Filter by today / 7 days / 30 days / all | Done |
| 7.3 | Search by bill number or customer name | Done |
| 7.4 | Takings and bill count for the shown range | Done |
| 7.5 | Reopen any bill and reprint it | Done |
| 7.6 | Abandoned drafts never appear as sales | Done |

---

## 8. Returns

| # | Requirement | Status |
|---|---|---|
| 8.1 | Take goods back against a finalised bill | Done |
| 8.2 | Refund at the **original** price, never today's rate | Done |
| 8.3 | Partial returns, tracked so nothing comes back twice | Done |
| 8.4 | Returned stock re-enters through the ledger; a unique piece becomes sellable | Done |
| 8.5 | The original bill is never modified — the return is its own document | Done |
| 8.6 | Refund by cash/bank/card, or written off a credit account | Done |
| 8.7 | Old gold the shop bought is never returnable | Done |
| 8.8 | Owner/Manager only | Done |

---

## 9. Customer credit (udhaar)

| # | Requirement | Status |
|---|---|---|
| 9.1 | A credit sale records who owes the money | Done |
| 9.2 | A credit sale without a customer is refused outright | Done |
| 9.3 | Append-only ledger; balances are folded from entries | Done |
| 9.4 | "Who owes me money", biggest first | Done |
| 9.5 | Per-customer statement with a running balance | Done |
| 9.6 | Record repayments by cash/bank/card | Done |
| 9.7 | Over-payment is refused rather than silently parked | Done |
| 9.8 | The POS shows what a customer already owes before more goes on the book | Done |
| 9.9 | Credit limits per customer; ageing reports | Not in v1 |

---

## 10. Karigar (goldsmith) jobs

| # | Requirement | Status |
|---|---|---|
| 10.1 | Take in raw metal from a karigar | Done |
| 10.2 | Issue metal out for a job | Done |
| 10.3 | Receive finished pieces back in | Done |
| 10.4 | Check wastage against the agreed tolerance on the way in | Done |
| 10.5 | Per-karigar metal account | Done |

---

## 11. Invoice printing

| # | Requirement | Status |
|---|---|---|
| 11.1 | A5 invoice with shop name, address, phone | Done |
| 11.2 | Itemised: metal, making, wastage, stones, hallmark, tax | Done |
| 11.3 | Old gold, discount, adjustment, rounding shown separately | Done |
| 11.4 | Print via Ctrl-P | Done |
| 11.5 | Thermal (ESC/POS) receipt printing | Not in v1 |

---

## 11a. Setup

| # | Requirement | Status |
|---|---|---|
| 11a.1 | A fresh install ships with the settings a Pakistani shop usually wants | Done |
| 11a.2 | A four-question wizard on first run: shop, tax, purities, done | Done |
| 11a.3 | The wizard never interrupts a shop that already has stock or sales | Done |
| 11a.4 | Unused gold purities are switched off, so they need no morning rate | Done |

## 11b. Reports

| # | Requirement | Status |
|---|---|---|
| 11b.1 | Profit split into what was earned and what the metal did | Done |
| 11b.2 | A piece with no recorded intake rate is reported as unknown, never guessed | Done |
| 11b.3 | The headline shows the profit that IS known rather than zero | Done |
| 11b.4 | Dead stock past a chosen age, most valuable first, with cash locked up | Done |
| 11b.5 | Profit is owner-only; dead stock is owner/manager | Done |

## 11c. Labels

| # | Requirement | Status |
|---|---|---|
| 11c.1 | Code 128 tag labels printed as an A4 sticker sheet | Done |
| 11c.2 | A piece with no tag number is reported, never printed blank | Done |

## 12. Data safety

| # | Requirement | Status |
|---|---|---|
| 12.1 | Automatic backup every 4 hours while running | Done |
| 12.2 | Backup on close, and before any version upgrade | Done |
| 12.3 | Every backup is integrity-checked; a bad one is discarded | Done |
| 12.4 | Old backups rotate; pre-upgrade ones are kept forever | Done |
| 12.5 | Owner can take a backup on demand | Done |
| 12.6 | Owner can restore a backup from inside the app | Done |
| 12.7 | Restoring snapshots the current data first, so it is undoable | Done |
| 12.8 | Tamper-evident audit trail (hash-chained) of every change | Done |
| 12.9 | Data lives in %APPDATA% and survives uninstall/reinstall | Done |
| 12.10 | Every verified backup is also copied to a USB drive or synced folder | Done |
| 12.11 | The off-site copy is verified too, and a corrupt one is discarded | Done |
| 12.12 | A missing USB drive is reported, never fatal to the local backup | Done |

---

## 13. Money and weight correctness

| # | Requirement | Status |
|---|---|---|
| 13.1 | All money is integer paisa; no floating point ever reaches storage | Done |
| 13.2 | All weight is integer milligrams | Done |
| 13.3 | Rounding happens once per component, never on intermediate values | Done |
| 13.4 | Identical inputs always produce identical figures, permanently | Done |
| 13.5 | A finalised invoice is immutable (enforced by the database) | Done |

---

## 14. Platform

| # | Requirement | Status |
|---|---|---|
| 14.1 | Windows 10/11, 64-bit | Done |
| 14.2 | Fully offline; no internet needed at any point | Done |
| 14.3 | One installation per PC (a second launch focuses the first) | Done |
| 14.4 | English interface | Done |
| 14.5 | Urdu interface | Done |
| 14.6 | Multiple tills sharing one database over a LAN | Not in v1 (the architecture is prepared for it) |

---

## Not in v1 — summary

Everything below is deliberately excluded from this release:

- Thermal (ESC/POS) receipt printing
- Item photographs
- Photo/OCR stock intake
- Multiple branches and stock transfers
- Per-customer credit limits and ageing
- LAN multi-till
