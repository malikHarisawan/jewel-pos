/**
 * Display formatting for the counter screens.
 *
 * Pakistani shops read money in the lakh/crore grouping (12,34,567) rather than
 * the thousands grouping, and weights to three decimals in grams with a tola
 * equivalent alongside. Storage stays integer paisa / milligrams — everything
 * here is presentation only.
 */
import { MG_PER_GRAM, TOLA_MG } from '../../../shared/units/index.js';

/** Indian/Pakistani digit grouping: last three digits, then pairs. */
export function groupPk(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return `${parts.join(',')},${last3}`;
}

/** Paisa → "1,23,456.78" (magnitude only; paisa dropped when they are .00). */
export function amount(paisa: number): string {
  const v = Math.abs(Math.round(paisa || 0));
  const rupees = groupPk(String(Math.floor(v / 100)));
  const p = v % 100;
  return p ? `${rupees}.${String(p).padStart(2, '0')}` : rupees;
}

/** Paisa → whole rupees only, for headline figures. */
export function amount0(paisa: number): string {
  return groupPk(String(Math.round(Math.abs(paisa || 0) / 100)));
}

/** Paisa → "Rs 1,23,456.78", with a minus sign for credits. */
export function rs(paisa: number): string {
  return `${(paisa || 0) < 0 ? '− Rs ' : 'Rs '}${amount(paisa)}`;
}

/** Paisa → "Rs 1,23,457" (no paisa), for KPI tiles. */
export function rs0(paisa: number): string {
  return `${(paisa || 0) < 0 ? '− Rs ' : 'Rs '}${amount0(paisa)}`;
}

/** Paisa → "+ Rs 2.00" / "− Rs 2.00", for signed adjustments like rounding. */
export function rsSigned(paisa: number): string {
  return `${(paisa || 0) < 0 ? '− ' : '+ '}Rs ${amount(paisa)}`;
}

/** Milligrams → "18.400" (grams, three decimals). */
export function g(mg: number): string {
  return (Math.round(mg || 0) / MG_PER_GRAM).toFixed(3);
}

/** Milligrams → "18.400 g". */
export function gu(mg: number): string {
  return `${g(mg)} g`;
}

/** Milligrams → "1.578" tola, at the shop's tola definition. */
export function tola(mg: number, tolaMg: number = TOLA_MG): string {
  return ((mg || 0) / (tolaMg || TOLA_MG)).toFixed(3);
}

/** "18.4" (grams, as typed) → 18400 mg. Tolerant of stray characters. */
export function parseG(input: string | number): number {
  const n = parseFloat(String(input).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * MG_PER_GRAM) : 0;
}

/** "1,234.56" (rupees, as typed) → 123456 paisa. */
export function parseRs(input: string | number): number {
  const n = parseFloat(String(input).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Plain number from a typed string, 0 when unparseable. */
export function parseNum(input: string | number): number {
  const n = parseFloat(String(input).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Gross − Less = Net, the trio the counter always reads together. */
export function trio(grossMg: number, lessMg: number): string {
  return `${g(grossMg)} − ${g(lessMg)} = ${g(grossMg - lessMg)} g`;
}

/** A timestamp as the ledger shows it: "2026-08-12 14:02". */
export function stamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Date only: "12 August 2026". */
export function longDate(d: Date = new Date()): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Weekday + date, the dashboard's subtitle: "Wednesday 12 August 2026". */
export function weekdayDate(d: Date = new Date()): string {
  return d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
