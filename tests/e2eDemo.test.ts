/**
 * End-to-end shop simulation: seed a realistic dataset and drive it through the
 * real service layer, the same functions the IPC handlers call. Complements the
 * unit tests by proving the pieces work TOGETHER on lifelike data.
 */
import { describe, it, expect } from 'vitest';
import { runDemo } from '../scripts/seed-demo.mjs';

describe('full shop simulation', () => {
  it('seeds and exercises every major flow', async () => {
    const { pass, fail } = await runDemo(':memory:');
    if (fail.length) console.error('failures:\n  ' + fail.join('\n  '));
    expect(fail).toEqual([]);
    expect(pass.length).toBeGreaterThan(12);
  });
});
