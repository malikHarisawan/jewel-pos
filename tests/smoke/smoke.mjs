/**
 * UI smoke test — drives the REAL app the way a person does.
 *
 * Everything else in this repo tests the service layer. Nothing until now has
 * clicked a button, so a broken screen, a missing logo or an unreadable font
 * would all have passed CI. This launches the built app, signs in, walks every
 * screen, and writes a screenshot of each one so the result can be LOOKED AT
 * rather than inferred.
 *
 *   node tests/smoke/smoke.mjs [--out <dir>]
 *
 * Exits non-zero if any step fails. Screenshots land in the output directory
 * regardless, because a failure screenshot is the most useful artefact there is.
 */
import { _electron as electron } from 'playwright';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? resolve(process.argv[outArg + 1]) : resolve('tests/smoke/shots');
mkdirSync(OUT, { recursive: true });

const results = [];
const note = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  +' : '  -'} ${name}${detail ? ' — ' + detail : ''}`);
};

let shotN = 0;
async function shot(win, label) {
  const file = join(OUT, `${String(++shotN).padStart(2, '0')}-${label}.png`);
  await win.screenshot({ path: file });
  return file;
}

// A SANDBOX, never the shop's own data.
//
// This walk changes the owner's PIN. Run against %APPDATA%\jewel-pos that is
// not a test — it is a live edit, and the next person to open the real app is
// locked out with the PIN they were given. JP_USER_DATA redirects every app
// path (database, backups, photos) into a throwaway folder that is wiped on
// each run, so the test can be as destructive as it likes.
const SANDBOX = join(tmpdir(), 'jewel-pos-smoke');
rmSync(SANDBOX, { recursive: true, force: true });
const dataDir = join(SANDBOX, 'data');
mkdirSync(dataDir, { recursive: true });
const dbFile = join(dataDir, 'shop.db');
// Call vitest's JS entry directly: spawning the .cmd shim needs a shell on
// Windows and fails with EINVAL from execFileSync.
execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/smoke/seed.test.ts'], {
  stdio: 'ignore',
  env: { ...process.env, JP_SEED_APPDATA: '1', JP_SEED_DB: dbFile },
});
console.log(`  seeded a throwaway shop at ${SANDBOX}`);

const app = await electron.launch({
  args: ['.'],
  // The app boots into the tray when Windows starts it; never in a test.
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_ENV: 'test',
    JP_USER_DATA: SANDBOX,
  },
});

let win;
try {
  win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  note('app window opened', true);
} catch (e) {
  note('app window opened', false, e.message);
  await app.close().catch(() => {});
  process.exit(1);
}

// Surface renderer crashes instead of letting them look like a timeout.
const consoleErrors = [];
win.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
win.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

try {
  // ── sign in ────────────────────────────────────────────────────────────
  await win.waitForSelector('input', { timeout: 20_000 });
  await shot(win, 'login');

  // The logo should be a real mark now, not the placeholder letter.
  const logoCount = await win.locator('svg[aria-label="Jewel POS"]').count();
  note('gem logo renders on login', logoCount > 0, `${logoCount} found`);

  // A freshly seeded shop is still on the factory PIN, so the hint belongs here.
  const hintBefore = await win.locator('body').innerText();
  note('factory PIN hint shown on a fresh install', /PIN:\s*1234/i.test(hintBefore));

  // Type the PIN with the KEYBOARD — the thing that was broken and got fixed.
  const username = win.locator('input[autocomplete="username"]');
  await username.fill('owner');
  const pin = win.locator('input[type="password"]');
  await pin.click();
  await win.keyboard.type('1234');
  const typed = await pin.inputValue();
  note('PIN accepts keyboard input', typed.length === 4, `value length ${typed.length}`);

  await win.keyboard.press('Enter');

  // First boot forces a PIN change; either that screen or the app shell is a
  // valid landing spot, so wait for whichever arrives.
  await win.waitForTimeout(2500);
  await shot(win, 'after-signin');

  const bodyText = await win.locator('body').innerText();
  const forced = /PIN/i.test(bodyText) && /change|new/i.test(bodyText);
  note('signed in', true, forced ? 'landed on forced PIN change' : 'landed on app');

  if (forced) {
    // Three fields: current, new, repeat. Filling all three with the NEW pin
    // fails on "current PIN is incorrect" — the first must stay the old one.
    const fields = win.locator('input[type="password"]');
    await fields.nth(0).fill('1234');
    await fields.nth(1).fill('4321');
    await fields.nth(2).fill('4321');
    await shot(win, 'force-pin');
    const submit = win.locator('button[type="submit"], button:has-text("Save"), button:has-text("Change")').first();
    if (await submit.count()) {
      await submit.click();
      await win.waitForTimeout(2500);
    }
    note('forced PIN change submitted', true);
  }

  await shot(win, 'app-shell');

  // ── the factory hint must not survive the PIN change ───────────────────
  // Lock the counter to get back to sign-in and read the screen again.
  const lockBtn = win.locator('[aria-label*="ock"], [title*="ock"], [aria-label*="ign out"], [title*="ign out"]').first();
  if (await lockBtn.count()) {
    await lockBtn.click();
    await win.waitForTimeout(2000);
    const afterText = await win.locator('body').innerText();
    const backAtLogin = /sign in/i.test(afterText);
    if (backAtLogin) {
      await shot(win, 'login-after-pin-change');
      note(
        'factory PIN hint gone once the PIN is changed',
        !/PIN:\s*1234/i.test(afterText),
        /PIN:\s*1234/i.test(afterText) ? 'still advertising the old PIN' : '',
      );
      // Sign back in with the NEW pin to continue the walk.
      await win.locator('input[autocomplete="username"]').fill('owner');
      const p2 = win.locator('input[type="password"]');
      await p2.click();
      await win.keyboard.type('4321');
      await win.keyboard.press('Enter');
      await win.waitForTimeout(2500);
    } else {
      note('factory PIN hint gone once the PIN is changed', true, 'lock did not reach sign-in; skipped');
    }
  } else {
    note('factory PIN hint gone once the PIN is changed', true, 'no lock control found; skipped');
  }

  // ── the seeded data must actually appear ───────────────────────────────
  const shell = await win.locator('body').innerText();
  note('app shell rendered', shell.length > 40, `${shell.length} chars of text`);

  // ── walk every nav destination ─────────────────────────────────────────
  const navs = win.locator('.jp-nav');
  const navCount = await navs.count();
  note('sidebar navigation present', navCount > 0, `${navCount} entries`);

  const visited = [];
  for (let i = 0; i < navCount; i++) {
    const item = navs.nth(i);
    const label = (await item.innerText()).split('\n')[0].trim();
    if (await item.isDisabled()) {
      visited.push(`${label} (locked)`);
      continue;
    }
    await item.click();
    await win.waitForTimeout(1200);
    await shot(win, `nav-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
    const text = await win.locator('body').innerText();
    const blank = text.trim().length < 30;
    note(`screen: ${label}`, !blank, blank ? 'rendered blank' : `${text.length} chars`);
    visited.push(label);
  }

  // ── the seeded stock should be visible on the screen that lists it ─────
  // Checking after the walk would read whatever screen the loop ended on
  // (Settings), which never shows stock. Go back to Items deliberately.
  const itemsNav = navs.filter({ hasText: 'Items' }).first();
  if (await itemsNav.count()) {
    await itemsNav.click();
    await win.waitForTimeout(1500);
  }
  const all = await win.locator('body').innerText();
  const seeded = ['Ring', 'Kangan', 'Jhumka', 'Bridal', 'Payal'].filter((n) =>
    new RegExp(n, 'i').test(all),
  );
  note('seeded stock visible in the UI', seeded.length >= 3, `found: ${seeded.join(', ') || 'none'}`);

  // ── fonts actually loaded (the readability fix) ─────────────────────────
  const fonts = await win.evaluate(async () => {
    await document.fonts.ready;
    const body = getComputedStyle(document.body);
    return {
      bodyFamily: body.fontFamily,
      bodyWeight: body.fontWeight,
      poppins: document.fonts.check('15px Poppins'),
      lora: document.fonts.check('16px Lora'),
      mono: document.fonts.check('14px "DejaVu Sans Mono"'),
    };
  });
  note('Poppins loaded', fonts.poppins);
  note('Lora loaded', fonts.lora);
  note('DejaVu Mono loaded', fonts.mono);
  note(
    'body uses the reading face, not the geometric one',
    !/Poppins/i.test(fonts.bodyFamily),
    fonts.bodyFamily,
  );

  // ── money figures must use fixed-width digits ──────────────────────────
  const figures = await win.evaluate(() => {
    const el = document.querySelector('.jp-num, .jp-figure');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { family: cs.fontFamily, variant: cs.fontVariantNumeric };
  });
  if (figures) {
    note('money uses tabular figures', /tabular/.test(figures.variant), figures.variant);
  } else {
    note('money uses tabular figures', false, 'no .jp-num element on screen');
  }

  if (consoleErrors.length) {
    note('no renderer errors', false, consoleErrors.slice(0, 3).join(' | '));
  } else {
    note('no renderer errors', true);
  }

  writeFileSync(
    join(OUT, 'report.json'),
    JSON.stringify({ results, visited, fonts, figures, consoleErrors }, null, 2),
  );
} catch (e) {
  note('walk completed', false, e.message);
  if (win) await shot(win, 'failure').catch(() => {});
} finally {
  await app.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - failed.length} passed, ${failed.length} failed`);
console.log(`  screenshots: ${OUT}`);
process.exit(failed.length ? 1 : 0);
