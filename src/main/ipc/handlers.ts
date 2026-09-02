/** Concrete handlers for each contract channel. Business logic lives in the
 * services; handlers are thin glue that read from the AppContext. */
import type { Handlers } from './router.js';
import { listItems, getItem, createItem, updateItem } from '../services/itemService.js';
import {
  purchaseIn,
  adjust,
  reverseMovement,
  listMovements,
  listBalances,
} from '../services/stockService.js';
import { enterRate, latestRates, rateHistory, quoteItems, quoteWeight } from '../services/rateService.js';
import { checkout, getInvoice, listInvoices } from '../services/invoiceService.js';
import { getSettings, updateSettings } from '../services/settingsService.js';
import { getSummary } from '../services/dashboardService.js';
import { createParty, listParties } from '../services/partyService.js';
import {
  issueJob,
  receiveJob,
  listJobs,
  karigarAccounts,
  rawMetalBalance,
  rawIntake,
  rawBalances,
} from '../services/karigarService.js';

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
    return updateSettings(ctx.db, session.userId, input);
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
