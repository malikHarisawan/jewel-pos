/**
 * Records the SETUP walkthrough — the video a shop watches on day one.
 *
 * Different from `demo.mjs`, which tours a shop already running. This one
 * starts from a virgin install (no seed, no stock, no rate) and walks the
 * first hour: sign in, take the PIN, name the shop, set tax, post the rate,
 * import the catalogue from a spreadsheet, ring up the first sale.
 *
 *   npm run demo:setup
 *
 * Output: docs/demo/jewel-pos-setup.webm plus a caption sheet.
 *
 * Two things are faked, both because the OS owns them and Playwright cannot:
 *   - downloading and installing (covered by the guide page instead)
 *   - the native file-picker, stubbed via JP_IMPORT_FILE the same way
 *     import-ui.mjs does it
 *
 * Everything else is the real application against a throwaway shop in
 * JP_USER_DATA; the shop's own data in %APPDATA% is never touched.
 */
import { _electron as electron } from 'playwright';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  renameSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const OUT = resolve('docs/demo');
mkdirSync(OUT, { recursive: true });

// The sheet the video imports. Sample #1 is the ordinary case: real-world
// headers, money written with commas, one blank row — nine rows, no manual
// column binding needed. That is what a shop should see the first time.
const SHEET = resolve(process.env.JP_IMPORT_FILE ?? 'docs/samples/1-typical-stock.xlsx');
if (!existsSync(SHEET)) {
  console.error(`  missing ${SHEET} — run: npm run samples`);
  process.exit(1);
}

// ── a virgin shop: no seed, so the video shows what a real first run shows ──
const SANDBOX = join(tmpdir(), 'jewel-pos-setup-demo');
rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(join(SANDBOX, 'data'), { recursive: true });
console.log('  empty shop at', SANDBOX);

const captions = [];
const t0 = Date.now();
const say = (text) => {
  const at = Number(((Date.now() - t0) / 1000).toFixed(1));
  captions.push({ at, text });
  console.log(`  ${String(at).padStart(6)}s  ${text}`);
};

const app = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_ENV: 'test',
    JP_USER_DATA: SANDBOX,
    JP_IMPORT_FILE: SHEET,
  },
  recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
});

const win = await app.firstWindow({ timeout: 30_000 });
await win.waitForLoadState('domcontentloaded');
await win.waitForSelector('input', { timeout: 20_000 });

/** Slower than a person types. The viewer is meant to follow along. */
const type = async (locator, text, delay = 90) => {
  await locator.click();
  await locator.fill('');
  await win.keyboard.type(text, { delay });
};
const beat = (ms = 1400) => win.waitForTimeout(ms);

/** Click if it is there and clickable; never abort the recording over one
 *  element. A demo that stops at 57s is worth less than one that skips a step
 *  and still reaches the end — the console names whatever was skipped. */
const tryClick = async (locator, what, timeout = 6000) => {
  try {
    if (!(await locator.count())) return false;
    await locator.click({ timeout });
    return true;
  } catch {
    console.log(`  (skipped: ${what})`);
    return false;
  }
};

const nav = (label) => win.locator('.jp-nav').filter({ hasText: label }).first();

const closeAnyModal = async () => {
  if (await win.locator('.ant-modal-wrap').count()) {
    await win.keyboard.press('Escape');
    await beat(700);
  }
};

const goTo = async (label, caption, wait = 2600) => {
  say(caption);
  await closeAnyModal();
  const n = nav(label);
  if (await n.count()) {
    await n.click();
    await beat(wait);
  }
};

try {
  // ── 1. the very first sign-in ─────────────────────────────────────────
  say('Your first sign-in. The app ships with one account: owner / 1234');
  await beat(2600);
  await type(win.locator('input[autocomplete="username"]'), 'owner');
  await beat(600);
  await type(win.locator('input[type="password"]'), '1234', 170);
  await beat(900);
  await win.keyboard.press('Enter');
  await beat(2800);

  // ── 2. the PIN it shipped with is not yours ───────────────────────────
  const onChangePin = (await win.locator('input[type="password"]').count()) >= 3;
  if (onChangePin) {
    say('The app now insists you pick your own PIN — 1234 is printed in the manual');
    await beat(2600);
    const fields = win.locator('input[type="password"]');
    await fields.nth(0).fill('1234');
    await beat(800);
    await fields.nth(1).fill('4321');
    await beat(800);
    await fields.nth(2).fill('4321');
    await beat(1100);
    say('Choose something only you know. There is no back door if you forget it');
    await beat(2400);
    const submit = win
      .locator('button[type="submit"], button:has-text("Change"), button:has-text("Save")')
      .first();
    if (await submit.count()) await submit.click();
    await beat(3000);
  }

  // ── 3. the setup card, which opens by itself ──────────────────────────
  // This replaced a walk through Settings. The old video narrated "three
  // things to set up" and typed the shop name into a Settings field; a new
  // shop is now asked four questions before it can reach any screen, so a
  // recording that navigates instead of answering them would be describing
  // software that no longer exists.
  say('A brand-new shop. The app asks four questions before anything else');
  await beat(3400);

  const wiz = win.locator('.ant-modal').filter({ hasText: 'shop called' }).first();
  if (await wiz.count()) {
    say('Step 1 — your shop name. This prints at the top of every bill');
    await beat(2600);
    await type(wiz.locator('input').nth(0), 'Al-Madina Jewellers', 70);
    await beat(900);
    await type(wiz.locator('input').nth(1), '0300-1234567', 70);
    await beat(800);
    await type(wiz.locator('input').nth(2), 'Sarafa Bazaar, Lahore', 55);
    await beat(1300);
    await tryClick(win.locator('.ant-modal button:has-text("Next")').first(), 'wizard next 1');
    await beat(2200);

    say('Step 2 — tax. Gold is already exempt, the FBR treatment');
    await beat(3200);
    await tryClick(win.locator('.ant-modal button:has-text("Next")').first(), 'wizard next 2');
    await beat(2200);

    say('Step 3 — which gold you deal in. Skip what you never sell');
    await beat(3000);
    // Each purity kept is another rate the owner must post every morning, so
    // the video picks one deliberately rather than ticking everything.
    await tryClick(
      win.locator('.ant-modal label').filter({ hasText: '22K' }).first(),
      '22K purity',
    );
    await beat(1600);
    say('Each one you keep is a rate you post every morning — so pick honestly');
    await beat(3000);
    await tryClick(win.locator('.ant-modal button:has-text("Next")').first(), 'wizard next 3');
    await beat(2400);

    say('That is the setup. Everything else already ships set the way shops want it');
    await beat(3400);
    await tryClick(
      win.locator('.ant-modal button:has-text("Start selling")').first(),
      'finish wizard',
    );
    await beat(3200);
  }

  // ── 4. the morning rate card ──────────────────────────────────────────
  // It opens on its own once the wizard closes, because no rate is posted.
  // Nothing in the app prices without one, which is exactly why this is the
  // second thing a new owner sees rather than a screen they must remember.
  // The card mounts a moment after the wizard closes — it waits on the setup
  // status before deciding to open. Counting immediately races that and drops
  // into the fallback while the card is still arriving, so wait for it.
  const card = win.locator('.ant-modal').filter({ hasText: 'Post today' }).first();
  let cardOpened = false;
  try {
    await card.waitFor({ state: 'visible', timeout: 12_000 });
    cardOpened = true;
  } catch {
    console.log('  (rate card did not open — using the Rates screen)');
  }
  if (cardOpened) {
    say('Now the rate. Nothing can be priced or sold until today’s is posted');
    await beat(3400);
    say('Quote it the way your market does — per tola, per gram, or per 10 grams');
    await beat(3000);
    await tryClick(
      win.locator('.ant-modal .seg-opt').filter({ hasText: 'tola' }).first(),
      'per-tola',
    );
    await beat(1200);

    const cardRate = win.locator('.ant-modal input.jp-num').first();
    if (await cardRate.count()) {
      await type(cardRate, '357000', 130);
      await beat(2000);
    }
    // Deliberately not "22K, 21K and 18K follow": this shop told the wizard it
    // deals in one purity, so there is nothing to derive and the board shows a
    // single row. Narrating the multi-purity case over a one-row card would be
    // describing a different shop — the check below is what caught it.
    say('The whole board fills from this one figure — check it, then post');
    await beat(3600);
    await tryClick(
      win.locator('.ant-modal button.btn-primary').first(),
      'post rates',
    );
    await beat(3000);
    say('One number, one tap, every morning. That is the whole daily chore');
    await beat(3200);
  } else {
    // The card is the expected path; if it did not open, post on the Rates
    // screen so the recording still shows a priced shop rather than stopping.
    await goTo('Rates', 'Post today’s gold rate — nothing prices without it', 3000);
    const puritySel = win.locator('.ant-select').last();
    if (await tryClick(puritySel, 'purity dropdown')) {
      await beat(1400);
      const opt = win.locator('.ant-select-item-option').filter({ hasText: '22K' }).first();
      const fallback = win.locator('.ant-select-item-option').first();
      if (!(await tryClick(opt, '22K option'))) await tryClick(fallback, 'first purity');
      await beat(1400);
    }
    await tryClick(win.locator('.seg-opt').filter({ hasText: 'tola' }).first(), 'per-tola');
    await beat(1200);
    const rateField = win.locator('input[placeholder="300,000"]').first();
    if (await rateField.count()) {
      await type(rateField, '357000', 130);
      await beat(1600);
      await tryClick(win.locator('button.btn-primary').first(), 'post rate');
      await beat(2800);
    }
  }
  say('Nothing is stored as a price. Post a new rate and every item reprices');
  await beat(3200);

  // ── 6. the catalogue, straight off a spreadsheet ──────────────────────
  await goTo('Settings', 'Now your stock. Most shops already have it in Excel', 3000);

  const importPanel = win.locator('.jp-panel').filter({ hasText: 'spreadsheet' }).first();
  if (await importPanel.count()) {
    await importPanel.scrollIntoViewIfNeeded();
    await beat(2200);
  }
  say('Import from a spreadsheet — no need to retype hundreds of pieces');
  await beat(3000);

  // The native picker cannot be driven; JP_IMPORT_FILE makes pickFile return
  // the sample, so the click is real and only the OS dialog is skipped.
  const chooseBtn = win
    .locator('button:has-text("Choose"), button:has-text("file")')
    .first();
  await tryClick(chooseBtn, 'choose file');
  await beat(3600);

  say('It reads your column names — "Gross Wt", "Net Wt", purity, making charge');
  await beat(3400);
  say('Every row is shown BEFORE anything is saved. Nothing is written yet');
  await beat(3600);

  const previewTable = win.locator('table').first();
  if (await previewTable.count()) {
    await previewTable.scrollIntoViewIfNeeded();
    await beat(2600);
  }

  say('Weights in tola instead of grams? Switch the unit and the preview follows');
  await beat(3000);
  say('A row it cannot read is listed with the reason, and simply skipped');
  await beat(3200);

  const importBtn = win
    .locator('button:has-text("Import")')
    .filter({ hasNotText: 'spreadsheet' })
    .first();
  if (await importBtn.count()) {
    say('Happy with the preview? Import — and only now is anything written');
    await tryClick(importBtn, 'import');
    await beat(2200);
    await tryClick(win.locator('.ant-modal button.ant-btn-primary').first(), 'confirm import');
    await beat(3600);
  }
  say('Opening stock is posted at the same time, so your ledger starts balanced');
  await beat(3000);

  // ── 7. the stock is really there ──────────────────────────────────────
  await goTo('Items', 'Your catalogue — imported, and already priced at today’s rate', 3400);
  say('No price was ever typed. Weight, purity and making charge produce it');
  await beat(3600);

  // ── 8. the first sale ─────────────────────────────────────────────────
  await goTo('Sale', 'You are open for business. Ringing up the first sale', 2800);
  const search = win.locator('input[placeholder*="Scan"], input[placeholder*="scan"]').first();
  if (await search.count()) {
    say('Scan the tag, or type the name and press Enter');
    await type(search, 'Ring', 130);
    await beat(1800);
    await win.keyboard.press('Enter');
    await beat(2800);
    say('The bill builds itself — metal, making and wastage at today’s rate');
    await beat(3400);
  }

  const checkoutBtn = win.locator('button:has-text("Complete sale")').first();
  if ((await checkoutBtn.count()) && (await checkoutBtn.isEnabled())) {
    say('F9 finishes the sale. The receipt opens, and stock drops by one');
    await tryClick(checkoutBtn, 'complete sale');
    await beat(3400);
    say('Hand it to the customer, or Ctrl-P to print');
    await beat(3600);
  }

  // ── 9. what happens next ──────────────────────────────────────────────
  await closeAnyModal();
  say('Add your counter staff under Settings — each picks their own PIN');
  await beat(3000);
  say('Backups run on their own: every 4 hours, on close, and before an upgrade');
  await beat(3200);
  say('That is the setup. Post the rate each morning — the rest is selling');
  await beat(3600);
} catch (e) {
  console.error('  setup walk failed:', e.message);
} finally {
  // The video only lands on disk once the context closes.
  await app.close().catch(() => {});
}

// Playwright names the file with a random id; give it one a client can read.
// The tour video lives in the same folder, so exclude it before picking newest.
const newest = readdirSync(OUT)
  .filter((f) => f.endsWith('.webm') && f !== 'jewel-pos-demo.webm')
  .map((f) => ({ f, t: statSync(join(OUT, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0];

if (newest) {
  const target = join(OUT, 'jewel-pos-setup.webm');
  rmSync(target, { force: true });
  renameSync(join(OUT, newest.f), target);
  console.log('\n  video:', target);
}

// ── did the walk actually do what it narrated? ─────────────────────────────
// Captions are written by this script, so they prove nothing on their own. The
// sandbox database does: if the video says a rate was posted and a sale rung
// up, there had better be rows for both. Without this check an earlier run
// produced a video narrating a rate that was never saved.
const checks = [];
try {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(join(SANDBOX, 'data', 'shop.db'), { readonly: true });
  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  const expect = (label, n, min) => {
    checks.push({ label, n, ok: n >= min });
    console.log(`  ${n >= min ? '+' : '!'} ${label}: ${n}`);
  };
  expect('items imported', count('items'), 1);
  expect('opening stock posted', count('stock_movements'), 1);
  expect('rate posted', count('metal_rates'), 1);
  expect('sale recorded', count('documents'), 1);

  // The walk now narrates two things the old one could not, so both are
  // checked rather than taken on the caption's word.
  const shopName = db
    .prepare(`SELECT value FROM app_settings WHERE key='shop_name'`)
    .get()?.value;
  expect(
    'wizard saved the shop name',
    shopName && shopName !== 'My Jewellers' ? 1 : 0,
    1,
  );
  // Every GOLD purity the shop kept must be priced by that one post — the
  // claim the card actually makes. Silver and platinum ship active and this
  // shop has never traded them, so the card deliberately does not demand
  // rates for them; asserting over every metal fails on correct behaviour.
  const unpricedGold = db
    .prepare(
      `SELECT COUNT(*) c FROM purities p
       JOIN metals m ON m.id = p.metal_id
       WHERE p.is_active = 1 AND m.name = 'Gold'
         AND NOT EXISTS (SELECT 1 FROM metal_rates r WHERE r.purity_id = p.id)`,
    )
    .get().c;
  expect('every gold purity kept is priced by one post', unpricedGold === 0 ? 1 : 0, 1);

  db.close();
} catch (e) {
  console.log('  ! could not verify the sandbox:', e.message);
}

writeFileSync(join(OUT, 'setup-captions.json'), JSON.stringify(captions, null, 2));
writeFileSync(
  join(OUT, 'setup-captions.txt'),
  captions.map((c) => `${String(c.at).padStart(7)}s  ${c.text}`).join('\n') + '\n',
);
console.log('  captions:', join(OUT, 'setup-captions.txt'));
console.log(`  ${captions.length} captions over ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const failed = checks.filter((x) => !x.ok);
if (failed.length) {
  const names = failed.map((x) => x.label).join(', ');
  console.error(`\n  the video narrates steps that left no trace: ${names}`);
  console.error('  do not ship it — fix the walk and re-record.\n');
  process.exit(1);
}
console.log('  every narrated step is backed by data in the sandbox\n');
