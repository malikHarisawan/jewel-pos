/** Concrete handlers for each contract channel. Business logic lives in the
 * services; handlers are thin glue that read from the AppContext. */
import { factoryPinStatus } from '../auth/authService.js';
import type { Handlers, AppContext } from './router.js';
import { listItems, getItem, createItem, updateItem } from '../services/itemService.js';
import {
  purchaseIn,
  adjust,
  reverseMovement,
  listMovements,
  listBalances,
} from '../services/stockService.js';
import { enterRate, latestRates, rateHistory, quoteItems, quoteWeight } from '../services/rateService.js';
import {
  checkout,
  getInvoice,
  listInvoices,
  getReturnableLines,
  returnSale,
} from '../services/invoiceService.js';
import { getSettings, updateSettings } from '../services/settingsService.js';
import { getSummary } from '../services/dashboardService.js';
import { createParty, listParties } from '../services/partyService.js';
import { listDebtors, getStatement, recordRepayment } from '../services/creditService.js';
import { listBackups, backupNow, restoreBackup } from '../db/backup.js';
import { exportAllToCsv } from '../db/csvExport.js';
import { basename } from 'node:path';
import {
  issueJob,
  receiveJob,
  listJobs,
  karigarAccounts,
  rawMetalBalance,
  rawIntake,
  rawBalances,
} from '../services/karigarService.js';

/** Backups and CSV exports need real file locations; a host without them
 * cannot serve these. */
function requirePlatform(ctx: AppContext): NonNullable<AppContext['platform']> {
  if (!ctx.platform) throw new Error('file access is not available in this environment');
  return ctx.platform;
}

export const handlers: Handlers = {
  'system.ping': (_ctx, input) => ({
    reply: `pong: ${input.message}`,
    at: new Date().toISOString(),
  }),

  'auth.login': async (ctx, input) => {
    const session = await ctx.auth.login(input.username, input.secret);
    return session;
  },

  'auth.logout': (ctx) => {
    ctx.auth.logout();
    return { ok: true };
  },

  'auth.me': (ctx) => ctx.auth.current(),
  'auth.factoryPin': (ctx) => factoryPinStatus(ctx.db),

  'catalog.purities': (ctx) => {
    const rows = ctx.db
      .prepare(
        `SELECT id, metal_id AS metalId, label, fineness_millesimal AS finenessMillesimal
         FROM purities WHERE is_active=1 ORDER BY metal_id, sort_order`,
      )
      .all() as Array<{
      id: number;
      metalId: number;
      label: string;
      finenessMillesimal: number;
    }>;
    return rows;
  },

  'catalog.all': (ctx) => {
    const axis = (table: string) =>
      ctx.db
        .prepare(`SELECT id, name FROM ${table} WHERE is_active=1 ORDER BY sort_order, name`)
        .all() as Array<{ id: number; name: string }>;
    const purities = ctx.db
      .prepare(
        `SELECT id, metal_id AS metalId, label, fineness_millesimal AS finenessMillesimal
         FROM purities WHERE is_active=1 ORDER BY metal_id, sort_order`,
      )
      .all() as Array<{ id: number; metalId: number; label: string; finenessMillesimal: number }>;
    const locations = ctx.db
      .prepare(`SELECT id, name, kind FROM locations WHERE is_active=1 ORDER BY id`)
      .all() as Array<{ id: number; name: string; kind: string }>;
    return {
      productTypes: axis('product_types'),
      metals: axis('metals'),
      purities,
      stoneTypes: axis('stone_types'),
      makingTypes: axis('making_types'),
      occasions: axis('occasions'),
      locations,
    };
  },

  'items.list': (ctx, input) => {
    const role = ctx.session?.role ?? 'SALESMAN';
    return listItems(ctx.db, role, input);
  },

  'items.get': (ctx, input) => {
    const role = ctx.session?.role ?? 'SALESMAN';
    return getItem(ctx.db, role, input.id);
  },

  'items.create': (ctx, input) => {
    const session = ctx.auth.requireSession();
    return createItem(ctx.db, session.userId, session.role, input);
  },

  'items.update': (ctx, input) => {
    const session = ctx.auth.requireSession();
    return updateItem(ctx.db, session.userId, session.role, input);
  },

  'stock.balances': (ctx, input) => listBalances(ctx.db, input),
  'stock.movements': (ctx, input) => listMovements(ctx.db, input),

  'stock.purchaseIn': (ctx, input) => {
    const session = ctx.auth.requireSession();
    return purchaseIn(ctx.db, session.userId, input);
  },

  'stock.adjust': (ctx, input) => {
    const session = ctx.auth.requireSession();
    return adjust(ctx.db, session.userId, input);
  },

  'stock.reverse': (ctx, input) => {
    const session = ctx.auth.requireSession();
    return reverseMovement(ctx.db, session.userId, input);
  },

  'rates.latest': (ctx) => latestRates(ctx.db),
  'rates.history': (ctx, input) => rateHistory(ctx.db, input),
  'rates.enter': (ctx, input) => {
    const session = ctx.auth.requireSession();
    return enterRate(ctx.db, session.userId, input);
  },
  'rates.quoteItems': (ctx, input) => quoteItems(ctx.db, input),
  'rates.quoteWeight': (ctx, input) => quoteWeight(ctx.db, input.itemId, input.netMg),

  'sales.checkout': (ctx, input) => {
    const session = ctx.auth.requireSession();
    return checkout(ctx.db, session.userId, {
      dateISO: new Date().toISOString(),
      // Role comes from the main-process session, never from the payload — this
      // is what makes the discount ceiling unfakeable from the renderer.
      role: session.role,
      customerId: input.customerId ?? null,
      saleLines: input.saleLines,
      oldGoldLines: input.oldGoldLines,
      payments: input.payments,
      discountApprovedBy: input.discountApprovedBy ?? session.userId,
      saleAdjustmentPaisa: input.saleAdjustmentPaisa,
    });
  },

  'sales.getInvoice': (ctx, input) => getInvoice(ctx.db, input.id),
  'sales.list': (ctx, input) => listInvoices(ctx.db, input),
  'sales.returnableLines': (ctx, input) => getReturnableLines(ctx.db, input.documentId),
  'sales.return': (ctx, input) => {
    const session = ctx.auth.requireSession();
    return returnSale(ctx.db, session.userId, {
      documentId: input.documentId,
      dateISO: new Date().toISOString(),
      lines: input.lines,
      refundMethod: input.refundMethod,
      reason: input.reason ?? null,
    });
  },

  'credit.debtors': (ctx, input) => listDebtors(ctx.db, input.includeSettled ?? false),
  'credit.statement': (ctx, input) => getStatement(ctx.db, input.partyId),
  'credit.repay': (ctx, input) => {
    const session = ctx.auth.requireSession();
    return recordRepayment(ctx.db, session.userId, {
      partyId: input.partyId,
      amountPaisa: input.amountPaisa,
      method: input.method,
      entryDate: new Date().toISOString(),
      notes: input.notes ?? null,
    });
  },

  'backup.list': (ctx) => (ctx.platform ? listBackups(ctx.platform.backupsDir) : []),
  'backup.now': async (ctx) => {
    const platform = requirePlatform(ctx);
    const res = await backupNow(ctx.db, platform.backupsDir, 'manual', new Date());
    return { name: basename(res.path), ok: res.ok };
  },
  'backup.restore': (ctx, input) => {
    const platform = requirePlatform(ctx);
    // Close the live handle BEFORE the file is swapped: on Windows an open
    // handle would either block the copy or leave the app reading a file that
    // no longer matches its page cache.
    ctx.db.pragma('wal_checkpoint(TRUNCATE)');
    ctx.db.close();
    const res = restoreBackup(platform.backupsDir, input.name, platform.dbPath);
    // The DB the whole process was built around is gone; restart into the
    // restored one rather than trying to rebuild every service in place.
    platform.relaunch();
    return res;
  },

  'export.csv': (ctx) => {
    const platform = requirePlatform(ctx);
    // Flush the WAL first: rows committed since the last checkpoint live only
    // in the -wal file, and a dump that silently omits today's sales is worse
    // than no dump at all.
    ctx.db.pragma('wal_checkpoint(TRUNCATE)');
    const res = exportAllToCsv(ctx.db, platform.exportsDir, new Date());
    platform.revealExport?.(res.folder);
    return res;
  },

  'parties.list': (ctx, input) => listParties(ctx.db, input),
  'parties.create': (ctx, input) => {
    const session = ctx.auth.requireSession();
    return createParty(ctx.db, session.userId, input);
  },

  'karigar.jobs': (ctx, input) => listJobs(ctx.db, input),
  'karigar.accounts': (ctx) => karigarAccounts(ctx.db),
  'karigar.rawBalance': (ctx, input) => ({ netMg: rawMetalBalance(ctx.db, input.purityId) }),
  'karigar.rawBalances': (ctx) => rawBalances(ctx.db),
  'karigar.rawIntake': (ctx, input) => {
    const session = ctx.auth.requireSession();
    return rawIntake(ctx.db, session.userId, input);
  },
  'karigar.issue': (ctx, input) => {
    const session = ctx.auth.requireSession();
    return issueJob(ctx.db, session.userId, new Date().toISOString(), input);
  },
  'karigar.receive': (ctx, input) => {
    const session = ctx.auth.requireSession();
    return receiveJob(ctx.db, session.userId, input);
  },

  'settings.get': (ctx) => getSettings(ctx.db),
  'settings.update': (ctx, input) => {
    const session = ctx.auth.requireSession();
    const next = updateSettings(ctx.db, session.userId, input);
    // Tray behaviour and the Windows login item are OS state, not just rows:
    // without this the checkbox saves and nothing actually changes.
    ctx.platform?.applyDesktopPrefs?.({
      closeToTray: next.close_to_tray !== '0',
      launchAtStartup: next.launch_at_startup === '1',
      shopName: next.shop_name,
    });
    return next;
  },

  'users.list': (ctx) => ctx.auth.listUsers(),
  'users.create': async (ctx, input) => {
    const session = ctx.auth.requireSession();
    const id = await ctx.auth.createUser(session.userId, input);
    return ctx.auth.listUsers().find((u) => u.id === id)!;
  },
  'users.setActive': (ctx, input) => {
    const session = ctx.auth.requireSession();
    ctx.auth.setUserActive(session.userId, input.userId, input.active);
    return { ok: true };
  },
  'users.resetPin': async (ctx, input) => {
    const session = ctx.auth.requireSession();
    await ctx.auth.resetPin(session.userId, input.userId, input.newSecret);
    return { ok: true };
  },
  'users.changeOwnPin': async (ctx, input) => {
    const session = ctx.auth.requireSession();
    await ctx.auth.changeOwnPin(session.userId, input.currentSecret, input.newSecret);
    return { ok: true };
  },

  'license.status': (ctx) => ctx.license.getInfo(),
  'license.activate': (ctx, input) => ctx.license.activate(input.code),

  'dashboard.summary': (ctx) => getSummary(ctx.db),
};
