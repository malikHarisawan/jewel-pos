/**
 * Seeds a database for the UI smoke test.
 *
 * Guarded twice over: it only runs when JP_SEED_APPDATA is set, and it writes
 * to whatever JP_SEED_DB names — a throwaway sandbox chosen by smoke.mjs, never
 * the shop's own %APPDATA% folder.
 */
import { it, expect } from 'vitest';
import { runDemo } from '../../scripts/seed-demo.mjs';

const target = process.env.JP_SEED_DB;

it.skipIf(!(process.env.JP_SEED_APPDATA === '1' && target))('seeds the database', async () => {
  const { pass, fail } = await runDemo(target!);
  expect(fail).toEqual([]);
  expect(pass.length).toBeGreaterThan(12);
});
