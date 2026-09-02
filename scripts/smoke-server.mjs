/**
 * Standalone smoke-test server. NOT part of the app — it exists so a real
 * browser (Playwright) can drive the actual renderer + contract + services
 * stack without Electron. It is literally the v2 "LAN server" adapter the
 * architecture was designed for: the SAME router over HTTP instead of IPC.
 *
 * It serves the built renderer from out/renderer and exposes POST /api/:channel.
 * A tiny injected shim points window.api.invoke at fetch.
 *
 * Run: node scripts/smoke-server.mjs   (after `npx electron-vite build`)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

// Allow importing the app's TS source directly via a loader-less approach:
// we import the already-built main bundle is CJS/ESM-mixed, so instead import
// the TS sources through tsx-style on-the-fly is overkill. The router + services
// are plain TS; we import the compiled test-friendly modules via a dynamic
// import of a small compiled entry. Simplest: import from source using Node's
// experimental strip-types (Node 22+ supports --experimental-strip-types).

const PORT = 5599;
const RENDERER_DIR = join(process.cwd(), 'out', 'renderer');

if (!existsSync(RENDERER_DIR)) {
  console.error('out/renderer not found. Run: npx electron-vite build');
  process.exit(1);
}

// Reuse the REAL app modules (via tsx). We avoid importing connection.ts because
// it pulls in the Vite-only `?raw` SQL import; instead we open the DB and run the
// canonical migration SQL directly here — same schema, same triggers.
import Database from 'better-sqlite3';
const { AuthService, ensureFirstOwner } = await import('../src/main/auth/authService.ts');
const { createRouter } = await import('../src/main/ipc/router.ts');
const { handlers } = await import('../src/main/ipc/handlers.ts');
const { LicenseService } = await import('../src/main/license/licenseService.ts');

const tmp = mkdtempSync(join(tmpdir(), 'jewelpos-smoke-'));
const db = new Database(join(tmp, 'shop.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Apply every migration .sql in filename order (0001, 0002, …) so the smoke DB
// matches what the app's migration runner produces.
const { readdirSync } = await import('node:fs');
const migDir = join(process.cwd(), 'src', 'main', 'db', 'migrations');
const migFiles = readdirSync(migDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
for (const f of migFiles) {
  db.exec(await readFile(join(migDir, f), 'utf8'));
}
db.pragma(`user_version = ${migFiles.length}`);
const auth = new AuthService(db);
const license = new LicenseService(db);
license.getInfo();
await ensureFirstOwner(db, auth);
console.log('[smoke] seeded owner in', tmp, '(migrations:', migFiles.join(', ') + ')');

const dispatch = createRouter(handlers, () => ({ db, auth, license, session: auth.current() }));

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

// Injected before the app bundle so window.api exists in the browser.
const SHIM = `
window.api = {
  invoke: async (channel, payload) => {
    const res = await fetch('/api/' + channel, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    return res.json();
  },
};
`;

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url?.startsWith('/api/')) {
      const channel = decodeURIComponent(req.url.slice('/api/'.length));
      const body = await readBody(req);
      const input = body ? JSON.parse(body) : {};
      try {
        const data = await dispatch(channel, input);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (err) {
        const code = err?.code ?? 'INTERNAL';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code, message: String(err?.message ?? err) } }));
      }
      return;
    }

    // Static renderer
    const noCache = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };
    const rawPath = (req.url ?? '/').split('?')[0];
    const urlPath = rawPath === '/' ? '/index.html' : rawPath;
    const filePath = join(RENDERER_DIR, urlPath);
    if (!existsSync(filePath) || extname(filePath) === '.html') {
      // index.html (and SPA fallback) — inject shim, never cache.
      const html = await readFile(join(RENDERER_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html', ...noCache });
      res.end(injectShim(html));
      return;
    }
    const ext = extname(filePath);
    const buf = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', ...noCache });
    res.end(buf);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});

function injectShim(html) {
  // Strip the app's strict CSP for this local smoke run (it blocks the inline
  // shim + the fetch transport); then inject the fetch-based window.api.
  const noCsp = html.replace(/<meta[^>]*Content-Security-Policy[^>]*>/i, '');
  return noCsp.replace('<head>', `<head><script>${SHIM}</script>`);
}

server.listen(PORT, () => {
  console.log(`[smoke] serving on http://localhost:${PORT}`);
});
