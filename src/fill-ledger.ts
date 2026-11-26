// Event-Sourced Execution Ledger (`fills.jsonl`): replaces hand-edited `holdings:` / `cash:` strings with an
// append-only, idempotent JSONL log of confirmed fills, broker CSV imports, dividends, and cash flows.
// Pure; zero Obsidian imports.

import type { Holding } from './account.ts';
import { readFills, type FillColumns } from './fills.ts';
import { hash } from './result-cache.ts';
import type { Bars } from './types.ts';

export type LedgerEventKind = 'fill' | 'dividend' | 'cash_flow' | 'opening_balance';
export type LedgerEventSide = 'buy' | 'sell' | 'short' | 'cover';

export interface LedgerEvent {
  /** Deterministic id for idempotent deduplication across repeated CSV imports. */
  id: string;
  /** UTC epoch milliseconds. */
  t: number;
  /** Account name (matches `account` block `name:`). */
  account: string;
  /** Optional strategy key this execution belonged to. */
  strategy?: string;
  kind: LedgerEventKind;
  ticker?: string;
  side?: LedgerEventSide;
  /** Positive share quantity for `fill` events. */
  quantity?: number;
  /** Execution price per share. */
  price?: number;
  /** Commission & fees paid (>= 0). */
  fees?: number;
  /** Net cash delta for `dividend`, `cash_flow`, or `opening_balance`. */
  cashDelta?: number;
  /** Opening holdings snapshot for `opening_balance` events. */
  holdings?: Holding[];
  source: 'confirm' | 'csv' | 'migration';
  note?: string;
}

export interface ProjectedAccount {
  holdings: Holding[];
  cash: number;
  totalFees: number;
  eventCount: number;
  /** Cost basis per ticker (average entry price of open shares). */
  costBasis: Map<string, number>;
}

const DAY_MS = 86_400_000;
/** Truncates an epoch ms timestamp to UTC midnight so daily bar comparisons align cleanly with intraday confirm timestamps. */
export const utcDay = (t: number): number => Math.floor(t / DAY_MS) * DAY_MS;

const KIND_ORDER: Record<LedgerEventKind, number> = { opening_balance: 0, cash_flow: 1, dividend: 2, fill: 3 };
const compareEvents = (a: LedgerEvent, b: LedgerEvent): number =>
  a.t - b.t || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Deterministic content hash for an execution event so re-importing the same broker CSV never duplicates fills. */
export function eventId(e: Omit<LedgerEvent, 'id'>, occurrence = 0): string {
  return hash(
    [
      e.t,
      e.account.toLowerCase(),
      e.kind,
      e.ticker?.toUpperCase() ?? '',
      e.side ?? '',
      e.quantity ?? 0,
      e.price ?? 0,
      e.fees ?? 0,
      e.cashDelta ?? 0,
      ...(occurrence > 0 ? [occurrence] : []),
    ].join('|'),
  ).toString(36);
}

/** Serializes one event as a single JSONL line. */
export function serializeLedgerEvent(e: LedgerEvent): string {
  return JSON.stringify(e);
}

/** Parses an append-only JSONL string into valid `LedgerEvent[]`, skipping blank or corrupt lines cleanly. */
export function parseLedgerJsonl(text: string): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Partial<LedgerEvent>;
      if (!obj || typeof obj.id !== 'string' || typeof obj.t !== 'number' || typeof obj.account !== 'string' || typeof obj.kind !== 'string') continue;
      if (seen.has(obj.id)) continue;
      seen.add(obj.id);
      out.push(obj as LedgerEvent);
    } catch {
      // Skip malformed line without corrupting the rest of the ledger.
    }
  }
  out.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** Creates an event from a 1-click "Confirm Fill" action in Today's Orders. */
export function createConfirmFillEvent(input: {
  account: string;
  strategy?: string;
  ticker: string;
  side: LedgerEventSide;
  quantity: number;
  price: number;
  fees?: number;
  t?: number;
  note?: string;
}): LedgerEvent {
  const base: Omit<LedgerEvent, 'id'> = {
    t: input.t ?? Date.now(),
    account: input.account,
    ...(input.strategy ? { strategy: input.strategy } : {}),
    kind: 'fill',
    ticker: input.ticker.toUpperCase(),
    side: input.side,
    quantity: Math.abs(input.quantity),
    price: input.price,
    fees: Math.max(0, input.fees ?? 0),
    source: 'confirm',
    ...(input.note ? { note: input.note } : {}),
  };
  return { id: eventId(base), ...base };
}

/**
 * Ingests a broker CSV export (Schwab, Fidelity, IBKR Flex/Statement, or generic CSV via `fills.ts`) and returns only
 * newly discovered `LedgerEvent[]` not already present in `existingIds`.
 */
export function ingestBrokerCsv(
  csvText: string,
  account: string,
  existingIds: ReadonlySet<string>,
  opts: { traded?: string[]; columns?: Partial<FillColumns> | null; since?: number } = {},
): { added: LedgerEvent[]; skippedDuplicates: number; warnings: string[] } {
  const saved = opts.columns ?? {};
  let parsed = readFills(csvText, opts.traded ?? [], saved);
  if (!parsed.ok) return { added: [], skippedDuplicates: 0, warnings: [parsed.reason] };
  if (!opts.traded && parsed.fills.length === 0 && parsed.untraded.length > 0) {
    parsed = readFills(csvText, parsed.untraded.map((u) => u.ticker), saved);
    if (!parsed.ok) return { added: [], skippedDuplicates: 0, warnings: [parsed.reason] };
  }
  const added: LedgerEvent[] = [];
  const seen = new Set(existingIds);
  const dupCounts = new Map<string, number>();
  let skippedDuplicates = 0;
  for (const f of parsed.fills) {
    if (opts.since !== undefined && f.date < opts.since) continue;
    const side: LedgerEventSide =
      f.action === 'short' ? 'short' : f.action === 'cover' ? 'cover' : f.side === 'buy' ? 'buy' : 'sell';
    const base: Omit<LedgerEvent, 'id'> = {
      t: f.date,
      account,
      kind: 'fill',
      ticker: f.ticker.toUpperCase(),
      side,
      quantity: f.quantity,
      price: f.price,
      fees: f.fees,
      source: 'csv',
    };
    // Distinguish multiple identical partial fills within the same CSV while keeping repeated CSV imports idempotent.
    const baseId = eventId(base);
    const occ = dupCounts.get(baseId) ?? 0;
    dupCounts.set(baseId, occ + 1);
    const id = occ === 0 ? baseId : eventId(base, occ);
    if (seen.has(id)) {
      skippedDuplicates++;
      continue;
    }
    seen.add(id);
    added.push({ id, ...base });
  }
  return { added, skippedDuplicates, warnings: [] };
}

/**
 * Projects current holdings, cash, cost basis, and fees deterministically from an opening balance + event stream.
 * Existing manual `holdings:` / `cash:` lines act as `opening` so migration is 100% seamless.
 */
export function projectAccountState(
  events: readonly LedgerEvent[],
  account: string,
  opening: { holdings?: readonly Holding[]; cash?: number; through?: number } = {},
): ProjectedAccount {
  const shares = new Map<string, number>();
  const basis = new Map<string, number>();
  for (const h of opening.holdings ?? []) {
    const k = h.ticker.toUpperCase();
    shares.set(k, (shares.get(k) ?? 0) + h.shares);
  }
  let cash = opening.cash ?? 0;
  let totalFees = 0;
  let eventCount = 0;
  const acctLower = account.toLowerCase();

  const sorted = [...events]
    .filter((e) => e.account.toLowerCase() === acctLower && (opening.through === undefined || e.t <= opening.through))
    .sort(compareEvents);

  for (const e of sorted) {
    eventCount++;
    if (e.kind === 'opening_balance') {
      shares.clear();
      basis.clear();
      for (const h of e.holdings ?? []) shares.set(h.ticker.toUpperCase(), h.shares);
      cash = e.cashDelta ?? 0;
      continue;
    }
    if (e.kind === 'dividend' || e.kind === 'cash_flow') {
      cash += e.cashDelta ?? 0;
      continue;
    }
    if (e.kind === 'fill' && e.ticker && e.quantity && e.price !== undefined) {
      const tk = e.ticker.toUpperCase();
      const qty = Math.abs(e.quantity);
      const fee = Math.max(0, e.fees ?? 0);
      totalFees += fee;
      const cur = shares.get(tk) ?? 0;
      const isBuy = e.side === 'buy' || e.side === 'cover';
      if (isBuy) {
        cash -= qty * e.price + fee;
        const next = cur + qty;
        if (cur >= 0 && next > 0) {
          const prevCost = (basis.get(tk) ?? e.price) * cur;
          basis.set(tk, (prevCost + qty * e.price) / next);
        } else if (cur < 0 && next > 0) {
          // Flipped from short to long: new long basis is this fill's price.
          basis.set(tk, e.price);
        }
        shares.set(tk, next);
      } else {
        cash += qty * e.price - fee;
        const next = cur - qty;
        if (cur <= 0 && next < 0) {
          const prevCost = (basis.get(tk) ?? e.price) * Math.abs(cur);
          basis.set(tk, (prevCost + qty * e.price) / Math.abs(next));
        } else if (cur > 0 && next < 0) {
          // Flipped from long to short: new short basis is this fill's price.
          basis.set(tk, e.price);
        }
        shares.set(tk, next);
      }
      if (Math.abs(shares.get(tk) ?? 0) < 1e-9) {
        shares.delete(tk);
        basis.delete(tk);
      }
    }
  }

  const holdings: Holding[] = [...shares.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([ticker, sh]) => ({ ticker, shares: Number(sh.toPrecision(12)) }));

  return { holdings, cash, totalFees, eventCount, costBasis: basis };
}

/**
 * Reconstructs a realized mark-to-market equity series over `timeline` from opening capital + execution ledger events.
 */
export function realizedEquitySeries(
  timeline: readonly number[],
  events: readonly LedgerEvent[],
  account: string,
  prices: Map<string, Bars>,
  opening: { holdings?: readonly Holding[]; cash: number },
): number[] {
  const acctLower = account.toLowerCase();
  const mine = events.filter((e) => e.account.toLowerCase() === acctLower).sort(compareEvents);
  const shares = new Map<string, number>();
  for (const h of opening.holdings ?? []) shares.set(h.ticker.toUpperCase(), h.shares);
  let cash = opening.cash;

  // Case-insensitive lookup for prices (handles lowercase CSV paths/tickers).
  const priceByUpper = new Map<string, Bars>();
  for (const [k, v] of prices) priceByUpper.set(k.toUpperCase(), v);

  // Detect daily+ bar cadence so intraday confirm timestamps align on the same UTC day instead of slipping +1 bar.
  const isDailyOrLonger = timeline.length < 2 || timeline[1] - timeline[0] >= DAY_MS - 60_000;
  const eventTime = (t: number) => (isDailyOrLonger ? utcDay(t) : t);

  // Cursor per price series
  const cursors = new Map<string, number>();
  const lastPrice = (ticker: string, t: number): number => {
    const b = priceByUpper.get(ticker);
    if (!b || b.t.length === 0) return 0;
    let i = cursors.get(ticker) ?? 0;
    while (i + 1 < b.t.length && b.t[i + 1] <= t) i++;
    cursors.set(ticker, i);
    return b.t[i] <= t ? b.c[i] : b.c[0];
  };

  const out = new Array<number>(timeline.length);
  let ev = 0;
  for (let k = 0; k < timeline.length; k++) {
    const t = timeline[k];
    while (ev < mine.length && eventTime(mine[ev].t) <= t) {
      const e = mine[ev++];
      if (e.kind === 'opening_balance') {
        shares.clear();
        for (const h of e.holdings ?? []) shares.set(h.ticker.toUpperCase(), h.shares);
        cash = e.cashDelta ?? 0;
      } else if (e.kind === 'dividend' || e.kind === 'cash_flow') {
        cash += e.cashDelta ?? 0;
      } else if (e.kind === 'fill' && e.ticker && e.quantity && e.price !== undefined) {
        const tk = e.ticker.toUpperCase();
        const qty = Math.abs(e.quantity);
        const isBuy = e.side === 'buy' || e.side === 'cover';
        const fee = Math.max(0, e.fees ?? 0);
        if (isBuy) {
          cash -= qty * e.price + fee;
          shares.set(tk, (shares.get(tk) ?? 0) + qty);
        } else {
          cash += qty * e.price - fee;
          shares.set(tk, (shares.get(tk) ?? 0) - qty);
        }
      }
    }
    let posVal = 0;
    for (const [tk, sh] of shares) if (Math.abs(sh) > 1e-9) posVal += sh * lastPrice(tk, t);
    out[k] = cash + posVal;
  }
  return out;
}
