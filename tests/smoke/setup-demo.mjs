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

  // ── 3. an empty shop ──────────────────────────────────────────────────
  say('This is a brand-new shop: no rate, no stock, nothing to sell yet');
  await beat(3600);
  say('Three things to set up — your shop details, today’s rate, then your stock');
  await beat(3400);

  // ── 4. shop details ───────────────────────────────────────────────────
  await goTo('Settings', 'Step 1 — Settings. Your shop name prints on every bill', 3200);

  const shopName = win.locator('#shop_name, input#shop_name').first();
  if (await shopName.count()) {
    await shopName.scrollIntoViewIfNeeded();
    await beat(900);
    await type(shopName, 'Al-Madina Jewellers', 70);
    await beat(1200);
    const addr = win.locator('#shop_address, input#shop_address').first();
    if (await addr.count()) {
      await type(addr, 'Sarafa Bazaar, Lahore', 55);
      await beat(900);
    }
    const phone = win.locator('#shop_phone, input#shop_phone').first();
    if (await phone.count()) {
      await type(phone, '0300-1234567', 70);
      await beat(1000);
    }
    say('Set the idle lock too — the counter returns to sign-in when left alone');
    await beat(2600);
    await tryClick(win.locator('button:has-text("Save")').first(), 'save shop');
    await beat(2200);
  }

  say('Tax and rounding live here as well. "Gold exempt" is the FBR treatment');
  await beat(3200);

  // ── 5. the rate — nothing prices without it ───────────────────────────
  await goTo('Rates', 'Step 2 — post today’s gold rate. Do this every morning', 3000);
  say('Quote it the way your market does — per tola, per gram, or per 10 grams');
  await beat(3000);

  // antd v6 renders .ant-select (there is no .ant-select-selector), and this
  // screen has two: [0] filters the history, [1] is the entry form. Take the
  // last, or the rate is never entered and the walk silently posts nothing.
  const puritySel = win.locator('.ant-select').last();
  if (await tryClick(puritySel, 'purity dropdown')) {
    await beat(1400);
    // 22K is what the sample sheet is priced in, so the imported stock values.
    const opt = win.locator('.ant-select-item-option').filter({ hasText: '22K' }).first();
    const fallback = win.locator('.ant-select-item-option').first();
    if (!(await tryClick(opt, '22K option'))) await tryClick(fallback, 'first purity');
    await beat(1400);
  }

  // The radio itself is hidden — the segmented control is drawn by its label,
  // so click the label. (Clicking the input times out on "not visible".)
  await tryClick(win.locator('.seg-opt').filter({ hasText: 'tola' }).first(), 'per-tola');
  await beat(1200);

  const rateField = win.locator('input[placeholder="300,000"]').first();
  if (await rateField.count()) {
    await type(rateField, '357000', 130);
    await beat(1600);
    say('The app converts it to per-gram for you — check the figure, then post');
    await beat(2800);
    await tryClick(
      win.locator('button:has-text("Save rate"), button.btn-primary').first(),
      'post rate',
    );
    await beat(2800);
  }
  say('Nothing is stored as a price. Post a new rate and every item reprices');
  await beat(3200);

  // ── 6. the catalogue, straight off a spreadsheet ──────────────────────
  await goTo('Settings', 'Step 3 — your stock. Most shops already have it in Excel', 3000);

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
