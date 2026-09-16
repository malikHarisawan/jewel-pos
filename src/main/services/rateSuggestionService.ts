/**
 * Suggested metal rates from an online source.
 *
 * Deliberately weak by design. A suggestion NEVER becomes a posted rate on its
 * own: the owner confirms it on the morning card, and only then does the normal
 * append-only `enterRate` path run. Two reasons that matters here:
 *
 *  - Pakistan's real benchmark is the All-Pakistan Gems & Jewellers Sarafa
 *    Association bulletin, announced each morning. Public APIs do not carry it;
 *    they compute spot x USD/PKR, which drifts from the bulletin — sometimes by
 *    thousands of rupees a tola. Pricing a sale off that silently would cost the
 *    shop real money, and `metal_rates` is append-only, so the error is
 *    permanent.
 *  - The product promise is "works offline, forever". So every failure here is
 *    non-fatal and quiet: no source configured, no network, a bad payload and a
 *    timeout all return the same `unavailable` shape, and the card still opens
 *    with yesterday's rate prefilled.
 *
 * Nothing in this file may throw into a caller or block startup.
 */
import type { DB } from '../db/connection.js';
import { getSettings } from './settingsService.js';
import { rupeesToPaisa } from '../../shared/units/index.js';

export type RateSourceId = 'OFF' | 'GOLDPRICEZ' | 'RAPIDAPI_PK';

export interface RateSuggestion {
  /** Paisa per gram, 24K (999) — the basis every other purity derives from. */
  ratePaisaPerGram: number;
  /** Which source answered, for display. The shop must always see the origin. */
  sourceId: RateSourceId;
  sourceLabel: string;
  fetchedAt: string;
}

export interface RateSuggestionResult {
  suggestion: RateSuggestion | null;
  /** Why there is no suggestion — shown as a quiet note, never as an error. */
  unavailableReason:
    | null
    | 'NOT_CONFIGURED'
    | 'NO_API_KEY'
    | 'OFFLINE'
    | 'BAD_RESPONSE'
    | 'TIMEOUT';
}

const SOURCE_LABEL: Record<RateSourceId, string> = {
  OFF: 'Off',
  GOLDPRICEZ: 'goldpricez.com',
  RAPIDAPI_PK: 'RapidAPI — Pakistan gold',
};

/** A shop PC on a bad connection must not make the owner wait to start selling. */
const FETCH_TIMEOUT_MS = 6_000;

/** Sanity band for a 24K paisa-per-gram rate, to reject a garbage payload.
 * Rs 1,000/g to Rs 500,000/g is far wider than any plausible market move; it
 * exists to catch a source returning USD, a zero, or an HTML error page. */
const MIN_SANE_PAISA_PER_GRAM = 100_000;
const MAX_SANE_PAISA_PER_GRAM = 50_000_000;

function isSane(paisaPerGram: number): boolean {
  return (
    Number.isFinite(paisaPerGram) &&
    Number.isInteger(paisaPerGram) &&
    paisaPerGram >= MIN_SANE_PAISA_PER_GRAM &&
    paisaPerGram <= MAX_SANE_PAISA_PER_GRAM
  );
}

/** `fetch` with a hard deadline; resolves to null rather than rejecting. */
async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the first finite number found at any of `paths` (dot notation). */
function pickNumber(payload: unknown, paths: string[]): number | null {
  for (const path of paths) {
    let cur: unknown = payload;
    for (const seg of path.split('.')) {
      if (cur == null || typeof cur !== 'object') {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[seg];
    }
    const n = typeof cur === 'string' ? Number(cur) : cur;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * goldpricez publishes a per-gram PKR figure for 24K. Field naming has varied
 * across their responses, so several shapes are accepted and the first sane one
 * wins; anything else is treated as "no suggestion".
 */
async function fetchGoldpricez(apiKey: string): Promise<number | null> {
  const payload = await fetchJson(
    `https://goldpricez.com/api/rates/currency/pkr/measure/gram`,
    { 'X-API-KEY': apiKey, Accept: 'application/json' },
  );
  if (!payload) return null;
  const perGramRupees = pickNumber(payload, [
    'gram_in_pkr_24k',
    'gram_in_pkr',
    'rates.pkr_gram_24k',
    'price_gram_24k',
  ]);
  return perGramRupees == null ? null : rupeesToPaisa(perGramRupees);
}

/**
 * The RapidAPI Pakistan feed quotes per tola. Converted here using the shop's
 * own tola length rather than a constant, so a shop on a 12.5g tola gets a
 * suggestion consistent with the rest of its books.
 */
async function fetchRapidApiPk(apiKey: string, tolaMg: number): Promise<number | null> {
  const payload = await fetchJson('https://gold-prices-pakistan.p.rapidapi.com/latest', {
    'X-RapidAPI-Key': apiKey,
    'X-RapidAPI-Host': 'gold-prices-pakistan.p.rapidapi.com',
    Accept: 'application/json',
  });
  if (!payload) return null;
  const perTolaRupees = pickNumber(payload, [
    'price_24k_tola',
    'tola_24k',
    'rates.24k_tola',
    'gold.24k.tola',
  ]);
  if (perTolaRupees == null) return null;
  // paisa per tola -> paisa per gram
  const perTolaPaisa = rupeesToPaisa(perTolaRupees);
  return Math.floor((perTolaPaisa * 1000 + tolaMg / 2) / tolaMg);
}

/**
 * Ask the configured source for today's 24K rate.
 *
 * Always resolves. Callers render `unavailableReason` as a quiet note beside a
 * manual entry field — never as a blocking error.
 */
export async function fetchRateSuggestion(db: DB): Promise<RateSuggestionResult> {
  const settings = getSettings(db);
  const sourceId = settings.rate_source as RateSourceId;

  if (sourceId === 'OFF') return { suggestion: null, unavailableReason: 'NOT_CONFIGURED' };

  const apiKey = settings.rate_source_api_key.trim();
  if (!apiKey) return { suggestion: null, unavailableReason: 'NO_API_KEY' };

  const tolaMg = Number(settings.tola_mg) || 11_664;

  let paisaPerGram: number | null = null;
  try {
    paisaPerGram =
      sourceId === 'GOLDPRICEZ'
        ? await fetchGoldpricez(apiKey)
        : await fetchRapidApiPk(apiKey, tolaMg);
  } catch {
    // fetchJson already swallows; this guards a source helper throwing.
    paisaPerGram = null;
  }

  if (paisaPerGram == null) return { suggestion: null, unavailableReason: 'OFFLINE' };

  const rounded = Math.round(paisaPerGram);
  if (!isSane(rounded)) return { suggestion: null, unavailableReason: 'BAD_RESPONSE' };

  return {
    suggestion: {
      ratePaisaPerGram: rounded,
      sourceId,
      sourceLabel: SOURCE_LABEL[sourceId],
      fetchedAt: new Date().toISOString(),
    },
    unavailableReason: null,
  };
}
