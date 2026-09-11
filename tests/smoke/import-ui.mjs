/**
 * Import UI check — proves the Import panel actually reaches the screen and
 * talks to the main process, not just that its module compiles.
 *
 * The file dialog cannot be driven from a test, so `import.pickFile` is not
 * exercised here. Everything downstream of it is: the panel renders, the
 * contract channels are registered, and `import.analyse` refuses a path the
 * user never picked — which is the guard the whole design rests on.
 *
 *   node tests/smoke/import-ui.mjs
 */
import { _electron as electron } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const OUT = resolve('tests/smoke/shots');
mkdirSync(OUT, { recursive: true });

const results = [];
const note = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  +' : '  -'} ${name}${detail ? ' — ' + detail : ''}`);
};

const SANDBOX = join(tmpdir(), 'jewel-pos-import-ui');
rmSync(SANDBOX, { recursive: true, force: true });
const dataDir = join(SANDBOX, 'data');
mkdirSync(dataDir, { recursive: true });
const dbFile = join(dataDir, 'shop.db');

execFileSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', 'tests/smoke/seed.test.ts'],
  { stdio: 'ignore', env: { ...process.env, JP_SEED_APPDATA: '1', JP_SEED_DB: dbFile } },
);
console.log(`  seeded a throwaway shop at ${SANDBOX}`);

const app = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_ENV: 'test',
    JP_USER_DATA: SANDBOX,
    // Overridable so the same harness can photograph the error case:
    //   JP_IMPORT_FILE=docs/samples/5-with-mistakes.xlsx node tests/smoke/import-ui.mjs
    JP_IMPORT_FILE: resolve(process.env.JP_IMPORT_FILE ?? 'docs/samples/1-typical-stock.xlsx'),
  },
});
const win = await app.firstWindow({ timeout: 30_000 });
await win.waitForLoadState('domcontentloaded');

// Surface renderer crashes instead of letting them look like a timeout.
const consoleErrors = [];
win.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
win.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

await win.waitForSelector('input', { timeout: 20_000 });

try {
  // ── sign in (fresh shop: factory PIN, then a forced change) ─────────────
  const pin = win.locator('input[type="password"]').first();
  await pin.fill('1234');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(2000);

  // First boot forces a PIN change. Three fields: current, new, repeat — the
  // first must stay the OLD pin or it fails on "current PIN is incorrect".
  const pwFields = win.locator('input[type="password"]');
  if ((await pwFields.count()) >= 3) {
    await pwFields.nth(0).fill('1234');
    await pwFields.nth(1).fill('4321');
    await pwFields.nth(2).fill('4321');
    const submit = win
      .locator('button[type="submit"], button:has-text("Change")')
      .first();
    await submit.click();
    await win.waitForTimeout(2500);
  }

  // ── the panel must be on the Settings screen ────────────────────────────
  const navCount = await win.locator('.jp-nav').count();
  if (navCount === 0) {
    const state = await win.locator('body').innerText();
    console.log('--- DID NOT REACH SHELL, body text follows ---');
    console.log(state.slice(0, 900));
    throw new Error('sign-in did not reach the app shell');
  }
  const settingsNav = win.locator('.jp-nav').filter({ hasText: /settings/i });
  await settingsNav.first().click();
  await win.waitForTimeout(1800);

  const body = await win.locator('body').innerText();
  note('Import panel is on the Settings screen', /Import from a spreadsheet/i.test(body));
  note(
    'panel explains it is not saved until confirmed',
    /Nothing is saved until/i.test(body),
  );

  const chooseBtn = win.locator('button', { hasText: /^Choose a file$/ });
  note('the Choose a file button is rendered', (await chooseBtn.count()) === 1);

  // Scroll the panel into view before the screenshot — it sits below the fold
  // on the Settings grid, and a shot of the top of the page proves nothing.
  await win
    .locator('.jp-panel', { hasText: 'Import from a spreadsheet' })
    .first()
    .scrollIntoViewIfNeeded();
  await win.waitForTimeout(600);
  await win.screenshot({ path: join(OUT, 'import-panel.png') });

  // ── the channels are registered and reachable from the renderer ─────────
  const fields = await win.evaluate(async () => {
    const r = await window.api.invoke('import.fields', {});
    return r.ok ? r.data.length : `error: ${r.error?.message}`;
  });
  note('import.fields answers the renderer', typeof fields === 'number' && fields > 10,
    `${fields} fields`);

  // ── the path guard: a path the user never picked must be refused ────────
  const forged = await win.evaluate(async () => {
    const r = await window.api.invoke('import.analyse', { filePath: 'C:\\Windows\\win.ini' });
    return r.ok ? 'ACCEPTED' : r.error?.message;
  });
  note(
    'a file path the user never picked is refused',
    typeof forged === 'string' && /not picked/i.test(forged),
    forged,
  );

  // ── the preview table itself ────────────────────────────────────────────
  // JP_IMPORT_FILE makes pickFile return the sample instead of opening a native
  // dialog, so the path travels the SAME route a real pick does — including the
  // guard that records it. Nothing here bypasses the check under test.
  const preview = await win.evaluate(async () => {
    const picked = await window.api.invoke('import.pickFile', {});
    if (!picked.ok) return { error: picked.error?.message };
    const r = await window.api.invoke('import.analyse', { filePath: picked.data.path });
    return r.ok ? r.data : { error: r.error?.message };
  });

  const DEFAULT_SAMPLE = !process.env.JP_IMPORT_FILE;
  if (preview.error) {
    note('preview rows carry resolved values', false, preview.error);
  } else if (!DEFAULT_SAMPLE) {
    note('preview returned rows for the chosen sheet', preview.rows.length > 0,
      `${preview.okRows} ok / ${preview.errorRows} with problems`);
  } else {
    const first = preview.rows[0];
    note(
      'preview resolves the purity to the app label',
      first.preview.purity === '22K / 916',
      `purity: ${first.preview.purity}`,
    );
    note(
      'preview resolves the metal the sheet never named',
      first.preview.metal === 'Gold',
      `metal: ${first.preview.metal}`,
    );
    note(
      'preview carries integer weights for the trio',
      first.preview.grossMg === 4250 && first.preview.netMg === 3900,
      `${first.preview.grossMg}mg / ${first.preview.netMg}mg`,
    );
    const lot = preview.rows.find((r) => r.preview.trackingMode === 'LOT');
    note('a multi-piece row previews as a LOT', Boolean(lot), lot ? lot.preview.name : 'none');
  }

  // Drive the panel's own button so the preview table actually renders, then
  // photograph it — the assertions above prove the data, this proves the table.
  await win.locator('button', { hasText: /^Choose a file$/ }).first().click();
  await win.waitForTimeout(2500);
  const previewBody = await win.locator('body').innerText();
  note(
    'the preview table renders resolved rows',
    DEFAULT_SAMPLE
      ? /22K \/ 916/.test(previewBody) && /UNIQUE/.test(previewBody)
      : /rows with problems/i.test(previewBody),
  );
  await win
    .locator('.jp-panel', { hasText: 'Import from a spreadsheet' })
    .first()
    .scrollIntoViewIfNeeded();
  await win.waitForTimeout(600);
  await win.screenshot({
    path: join(OUT, DEFAULT_SAMPLE ? 'import-preview.png' : 'import-preview-errors.png'),
    fullPage: true,
  });

  note('no renderer errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await app.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - failed.length} passed, ${failed.length} failed`);
console.log(`  screenshots: ${OUT}`);
process.exit(failed.length === 0 ? 0 : 1);
