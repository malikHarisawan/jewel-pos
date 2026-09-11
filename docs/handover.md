# Jewel POS 1.0.0 — Handover

Two parts: what the **shop** needs to know, and what **you** (the vendor) need
to keep.

---

# Part A — For the shop

## Installing

1. Double-click **`Jewel POS Setup 1.0.0.exe`**.
2. Windows may show a blue "Windows protected your PC" box. Click
   **More info → Run anyway**. (This appears because the installer is not yet
   code-signed. It is safe; see Part B if you want it gone.)
3. Choose where to install, or accept the default.
4. Finish. A **Jewel POS** shortcut is on the desktop.

Windows 10 or 11, 64-bit. No internet needed — ever.

## First run

1. Sign in with:
   - Username: **`owner`**
   - PIN: **`1234`**
2. The app will immediately make you **choose your own PIN**. This is on
   purpose — the starting PIN is printed in this document, so anyone who has
   read it knows yours until you change it.
3. You are in. The app runs free for **7 days**.

## Setting up your shop (about 10 minutes)

Do these in order. The app will not price anything until step 3 is done.

**1. Shop details** — *Settings (click it in the sidebar; it has no F-key, because F9 finalises a sale)*
Shop name, address, phone. These print at the top of every bill.
Also set **"Lock the counter after"** — the app returns to the sign-in screen
after this many idle minutes. `10` is sensible. `0` turns it off.

**2. Tax and rounding** — *Settings*
- Tax rate — set `0` if you do not charge it.
- Tax base — **"Gold exempt"** is the FBR treatment (tax on making and stones
  only, not on the metal).
- Rounding — **"Nearest rupee"** is normal.

**3. Today's rate** — *Rates (F4)*
Enter the gold rate for each purity you deal in. You can type it **per tola**,
**per gram**, or **per 10 grams** — whichever way your market quotes it.

> **Do this every morning.** Nothing can be priced or sold without a rate.

**4. Your staff** — *Settings → Users*
Add your counter staff as **Salesman**. Give each one a starting PIN; the app
forces them to pick their own the first time they sign in.

- **Salesman** can only use the POS.
- **Manager** can do everything except manage users, discount limits, and backups.
- **Owner** can do everything.

**5. Discount limits** — *Settings*
How much each role may cut off a bill on their own. Default: salesman 5%,
manager 20%. A sale beyond the limit is refused and needs you.

**6. Your stock** — *Items (F2)*
Add each piece. Two kinds:
- **Unique** — one tagged piece (a ring, a set). Sold whole.
- **Lot** — bulk stock sold by weight (chain by the gram).

## Day to day

| Key | Screen | |
|---|---|---|
| **F1** | Dashboard | Today's rate, what is on the shelves, what it is worth |
| **F2** | Items | Your catalogue |
| **F3** | Purchases | Bring stock in, correct it, reverse mistakes |
| **F4** | Rates | Post today's rate |
| **F5** | POS | Sell |
| **F6** | Sales | Every past bill |
| **F7** | Udhaar | Who owes you money |
| **F8** | Karigar | Goldsmith jobs |

### Making a sale
1. **F5**.
2. Scan the tag, or type a name and press **Enter** to add the top match.
3. Taking old gold? Click **Old gold**, enter weight and % touch. It comes off
   the bill and the metal enters your stock automatically.
4. Discount if you want to (in Rs or %), or type a custom final amount.
5. Choose the customer if the bill is going on udhaar — **this is required for
   credit**.
6. **F9** to finish. The receipt opens; **Ctrl-P** prints it.

### Taking something back
**F6** → find the bill → **Return** → enter what is coming back → **Take it
back**.

The customer is refunded **what they paid**, not today's rate. If gold has gone
up since, you do not lose; if it has gone down, they do not.

### Udhaar
Sales paid with **CREDIT** appear under **F7**. Click **Statement** to see a
customer's history and record a payment when they settle up.

## Your data is safe

Backups happen automatically:
- Every 4 hours while the app is open
- Every time you close it
- Before any version upgrade

To take one yourself or **put an old one back**: *Settings → Backups*
(owner only). Restoring saves a copy of your current data first, so it can be
undone.

Your data lives in `%APPDATA%\jewel-pos\` and **survives uninstalling**.

## Rules the app will not let you break

These are deliberate. They protect your books.

- A finished bill can never be edited. Fix a mistake with a **Return**.
- Stock can never go negative.
- The stock ledger and rate history can never be edited or deleted, only added to.
- A sold piece cannot move again unless it is returned.
- A credit sale must name a customer.
- Payments must add up to the bill exactly.

## If something goes wrong

**"No rate set for purity…"** — Post today's rate on **F4**.

**"Discount exceeds the X% limit"** — The cashier is discounting more than their
role allows. An owner or manager must ring up that sale.

**"A credit sale needs a customer"** — Pick the customer, or change the payment
method.

**App will not open / data looks wrong** — *Settings → Backups → Restore*.

**Forgot the owner PIN** — Contact your supplier. There is no back door; that is
the point.

## Licensing

You have **7 days free**, then **3 days grace** with a warning, then the app
locks until activated.

To activate: read your **Machine ID** off the lock screen (it is also in the
bottom-right corner of the app) to your supplier. They send back a code. Paste
it in. Done — permanently, and offline.

The code only works on that one PC.

---

# Part B — For the vendor

## Building a release

```
npm ci
npm run verify      # typecheck + lint + 210 tests
npm run smoke       # drives the real app, walks every screen, writes screenshots
npm run dist        # -> dist/Jewel POS Setup 1.0.0.exe
```

`verify` proves the rules; `smoke` proves the app still opens. The unit tests
never click a button, so a blank screen or a missing font passes `verify` and
fails `smoke`. Run both before shipping, and look at the screenshots it leaves
in `tests/smoke/shots/` — that is the point of them.

## Licensing a shop

Your signing key is `license-private.pem` in the project root.

> **Guard it.** It is git-ignored and must never be committed or shipped.
> Whoever holds it can mint licences for any machine. Keep an offline copy —
> if you lose it, no existing installation can be re-licensed and you must
> ship a new public key to every shop.

The public key in `src/shared/license/publicKey.ts` is already the matching
half. **Verified working** — do not change it, or every licence you have
already issued stops verifying.

```
# perpetual licence
node scripts/license-sign.mjs <machineId>

# licence that expires (e.g. annual subscription)
node scripts/license-sign.mjs <machineId> 2027-01-01
```

Send the printed code to the shop.

## Testing a build

Launch `dist\win-unpacked\Jewel POS.exe`, or silent-install with
`"Jewel POS Setup 1.0.0.exe" /S /D=C:\some\path`.

A booted app leaves proof in `%APPDATA%\jewel-pos\`: `data\shop.db` plus a
`pre-migration` backup. If that folder is missing, the app did not start.

> **Gotcha:** if `ELECTRON_RUN_AS_NODE` is set in your shell, *any* Electron app
> exits instantly with code 0 and no window — it runs the binary as plain Node.
> It looks exactly like a broken build. Check it first:
> `echo $env:ELECTRON_RUN_AS_NODE` (PowerShell). Clear with
> `Remove-Item Env:\ELECTRON_RUN_AS_NODE`.

## Code signing (recommended)

Without a certificate, Windows SmartScreen warns on first run and some shops
will be put off. To fix, buy an OV/EV code-signing certificate and add to
`electron-builder.yml`:

```yaml
win:
  certificateFile: path/to/cert.pfx
  certificatePassword: ...   # better: set CSC_LINK / CSC_KEY_PASSWORD env vars
```

## Enabling auto-update

Currently **off by design**. `electron-builder.yml` still points at
`https://example.com/updates/`, and `src/main/updater.ts` treats that as "no
channel configured" so it never fires pointless requests on an offline shop PC.

To turn it on:
1. Put a real HTTPS host in the `publish.url` of `electron-builder.yml`.
2. `npm run dist` and upload the contents of `dist/` (including `latest.yml`)
   to that URL.

Updates then download quietly and install **when the shop closes the app** —
never mid-sale.

## Shipping an update

Bump `version` in `package.json`, rebuild, ship. Migrations run automatically on
first launch, and a `pre-migration` backup is taken and verified **before** the
schema changes. If that backup fails its integrity check the upgrade aborts and
the old database is left untouched.

## Where the shop's data lives

```
%APPDATA%\jewel-pos\data\shop.db     the database
%APPDATA%\jewel-pos\backups\         backups
```

## Known limits of the licence scheme

It stops casual copying, link-sharing, and "install it on ten counters". It is
not unbreakable — a determined technical user on their own PC can tamper with a
local database. That is inherent to offline software with no server. What
matters commercially is that **nobody can forge a licence for a new machine**
without your private key, and that property holds.

## Not in this release

Urdu, thermal receipt printing, barcode labels, item photos, sales/profit
reports, multi-branch, credit limits and ageing, LAN multi-till, off-site
backup. See `docs/requirements.md` for the full list.
