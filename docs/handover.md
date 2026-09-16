# Jewel POS 1.1.0 — Handover

Two parts: what the **shop** needs to know, and what **you** (the vendor) need
to keep.

---

# Part A — For the shop

## Installing

1. Double-click **`Jewel POS Setup 1.1.0.exe`**.
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

## Setting up your shop (about 2 minutes)

The app opens with a **short setup card** asking four things: your shop name and
phone, whether you charge tax, and which gold purities you deal in. Answer those
and you are ready to sell.

Everything else already arrives set the way a Pakistani jewellery shop normally
wants it — gold exempt from tax (the FBR treatment), rounding to the nearest
rupee, a tola of 11.664 g, the standard purities. All of it is editable later in
*Settings*.

> Pick only the purities you actually sell. Every one you keep is a rate you
> would otherwise have to post each morning.

### Then, each morning

A **rate card** appears when today's rate has not been posted yet. Type the 24K
rate — or accept the suggested one — and the app fills in 22K, 21K and 18K for
you by purity. One number, one tap, the whole board.

You can still post any purity by hand on *Rates (F4)* whenever you want.

**Optional: a suggested rate from the internet.** In *Settings → Rates* you can
turn on an online source. It only ever **suggests** — you confirm before
anything is posted, because the number a website computes can differ from your
sarafa bazaar rate. Leave it **Off** (the default) and the app stays completely
offline, exactly as before.

The app also queries a rate that jumps more than 5% from your last one, which
catches a mistyped extra zero before it prices a sale.

### The rest of your setup

**Your staff** — *Settings → Users*
Add your counter staff as **Salesman**. Give each one a starting PIN; the app
forces them to pick their own the first time they sign in.

- **Salesman** can only use the POS.
- **Manager** can do everything except manage users, discount limits, and backups.
- **Owner** can do everything.

**Discount limits** — *Settings*
How much each role may cut off a bill on their own. Default: salesman 5%,
manager 20%. A sale beyond the limit is refused and needs you.

**Your stock** — *Items (F2)*
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
| — | Reports | What you actually made, and what is not selling |

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

### Printing tag labels
*Items (F2)* → **Print labels**. Prints a sheet of stickers for everything in
your current list, each with a scannable barcode of its tag number. Stick them
on the pieces and the POS can scan them straight in.

A piece with no tag number is skipped and the app tells you how many — add a tag
on the item first.

### Reports — what you actually made
The **Reports** screen answers two things your books know but you cannot work
out in your head:

**What you actually made.** Your profit split into two parts:
- **You earned** — making, wastage and stones. Your own work.
- **The gold did** — what the metal itself gained or lost between the day you
  bought the piece and the day you sold it.

That second number is the one no notebook can give you. It needs the rate on the
bill compared against the rate the piece came in at.

> If a piece has no purchase rate recorded, the app says so and leaves that part
> out rather than guessing. The heading reads **"Profit so far"** when some bills
> are still missing their cost. Add a purchase rate on those pieces to complete
> the picture.

**Money asleep on the shelf.** Everything that has not moved in 90 days, 6 months
or a year — most valuable first — and how much cash is tied up in it.

## Your data is safe

Backups happen automatically:
- Every 4 hours while the app is open
- Every time you close it
- Before any version upgrade

To take one yourself or **put an old one back**: *Settings → Backups*
(owner only). Restoring saves a copy of your current data first, so it can be
undone.

Your data lives in `%APPDATA%\jewel-pos\` and **survives uninstalling**.

### Keep a second copy somewhere else
Your whole book sits on this one PC. If it is stolen or the disk dies, the
backups die with it.

*Settings → Backups → Second copy*: put in a folder and every backup is copied
there as well. Use a **USB stick** (leave it plugged in), or a folder your
**Google Drive / Dropbox / OneDrive** syncs.

The copy is checked like the original — a bad one is thrown away rather than
kept. If the USB stick is unplugged the app simply says so; your normal backup
still happened.

## Rules the app will not let you break

These are deliberate. They protect your books.

- A finished bill can never be edited. Fix a mistake with a **Return**.
- Stock can never go negative.
- The stock ledger and rate history can never be edited or deleted, only added to.
- A sold piece cannot move again unless it is returned.
- A credit sale must name a customer.
- Payments must add up to the bill exactly.

## If something goes wrong

**"Post today's 22K / 916 rate before selling it — press F4."** — Exactly that:
the rate for that purity has not been posted. The morning card does this for you
if you let it.

**The POS shows an amber "Today's rate has not been posted" bar** — you are
selling on yesterday's rate. Post today's on **F4**.

**"That is 12.4% higher than the last posted rate"** — the app is double-checking
before you post. If the figure is right, click **Post anyway**.

**"Discount exceeds the X% limit"** — The cashier is discounting more than their
role allows. An owner or manager must ring up that sale.

**"A credit sale needs a customer"** — Pick the customer, or change the payment
method.

**App will not open / data looks wrong** — *Settings → Backups → Restore*.

**Forgot the owner PIN** — Contact your supplier. There is no back door; that is
the point.

## Urdu

*Settings → Appearance* switches the whole interface to Urdu, right-to-left.
Every screen is translated.

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
npm run verify      # typecheck + lint + 352 tests
npm run smoke       # drives the real app, walks every screen, writes screenshots
npm run dist        # -> dist/Jewel POS Setup 1.1.0.exe
```

### The two videos

```
npm run demo         # -> docs/demo/jewel-pos-demo.webm    a tour of a working shop
npm run demo:setup   # -> docs/demo/jewel-pos-setup.webm   day one, from an empty install
```

Both drive the real application, so a UI change dates them — re-record and the
video is current again. `demo:setup` starts from an *unseeded* shop and walks
what a new owner actually does: first sign-in, the forced PIN change, shop
details, posting a rate, importing stock from a spreadsheet, the first sale.

It checks itself against the sandbox database afterwards and exits non-zero if
a narrated step left no rows behind — a caption is only this script's own
claim, and an early cut narrated a rate that was never saved.

The client-facing guide wraps that video with the download and install steps
(which happen outside the app, where Playwright cannot follow).

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
`"Jewel POS Setup 1.1.0.exe" /S /D=C:\some\path`.

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

## The rate suggestion source

Off by default, so a shop that never opens Settings never makes a network call.

Both supported sources (goldpricez, RapidAPI) need the shop's own API key, typed
in *Settings → Rates*. There is no shared key in the build and nothing is sent
anywhere except that one GET.

`src/main/services/rateSuggestionService.ts` is deliberately defensive: a 6s
timeout, a sanity band on the returned figure, and every failure — no key, no
network, junk payload — collapses to "no suggestion" so the morning card still
opens with yesterday's rate prefilled. **A suggestion is never posted without the
owner confirming it**, which is the point: public APIs compute spot × USD/PKR and
drift from the Sarafa Association bulletin the bazaar actually follows.

To add a source, implement one fetch function and add it to the switch — the
sanity check and the confirm-before-post flow are shared.

## Not in this release

Thermal receipt printing, item photos, photo/OCR stock intake, multi-branch,
credit limits and ageing, LAN multi-till. See `docs/requirements.md` for the
full list.
