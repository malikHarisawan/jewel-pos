import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Flat config. The load-bearing rule is the import boundary: src/shared must
 * stay pure (no electron/node/@main imports) so it can be lifted into a LAN
 * server later without a rewrite.
 */
export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Node contexts: main process, preload, test harness scripts, config files.
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'scripts/**/*.{js,mjs}',
      '*.{js,mjs,ts}',
      'tests/**/*.ts',
    ],
    languageOptions: { globals: { ...globals.node } },
  },

  // Renderer runs in the browser.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },

  // The shared purity boundary — the important one.
  {
    files: ['src/shared/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'src/shared must stay Electron-free.' },
            { name: 'better-sqlite3', message: 'src/shared must stay DB-free.' },
          ],
          patterns: [
            { group: ['node:*'], message: 'src/shared must stay Node-free.' },
            {
              group: ['@main/*', '../main/*', '../../main/*'],
              message: 'src/shared cannot import main.',
            },
          ],
        },
      ],
    },
  },
);
