import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // better-sqlite3 is a native CJS addon; don't let Vite try to transform it.
    server: { deps: { external: ['better-sqlite3'] } },
  },
});
