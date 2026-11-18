// The `account` block: an account's holdings and cash, the strategies it follows with their shares of it, and the
// orders that bring it to what those strategies hold together. Pure; the caller runs the strategies.

import { MAX_ENTRIES, duplicateEntries, parseLine, runEntry, weightProblems, type CompareEntry, type CompareHost, type EntryRun } from './compare.ts';
import type { Diagnostic, Rebalance, Sizing } from './dsl.ts';
import type { AssetState } from './engine.ts';
import { parseFillColumns, type FillColumns } from './fills.ts';
import { money } from './format.ts';
import type { RunOutput } from './runner.ts';

export interface Holding {
  /** In capitals, as a strategy's universe spells a Yahoo or Binance ticker. */
  ticker: string;
  shares: number;
}

export interface AccountConfig {
  name: string | null;
  holdings: Holding[];
  cash: number;
  wholeShares: boolean;
  /** Resizing orders smaller than this share of the money the strategies manage are not made; 0 makes every one. */
  skipUnder: number;
  /** Vault path of the broker's CSV file of trades. */
  fills: string | null;
  /** UTC midnight of the first day the account followed the strategies. */
  fillsFrom: number | null;
  capitalAtStart: number | null;
  /** The headers the fills file's columns go by, where they are not the usual ones. */
  fillColumns: Partial<FillColumns> | null;
}

export const SETTINGS = ['name', 'holdings', 'cash', 'whole shares', 'skip under', 'fills', 'fills from', 'capital at start', 'fills columns'] as const;
type Setting = (typeof SETTINGS)[number];

const SETTING_LINE = /^([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/;
const MONEY = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*([kKmM]?)$/;
const PERCENT = /^(\d+(?:\.\d+)?)\s*%$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TICKER = /^[A-Za-z0-9^._=-]+$/;
/** A comma that separates holdings, not one inside a number such as 1,200. */
const BETWEEN_HOLDINGS = /;|,(?!\d{3}(?!\d))/;

const NOT_A_LINE =
  'This line is neither a setting nor a strategy. A setting is written such as cash: 10,000, and a strategy as [[Note name]] 40% or [[Note name#Strategy name]] 40%';
const settingList = () => `${SETTINGS.slice(0, -1).join(', ')} and ${SETTINGS[SETTINGS.length - 1]}`;

/** An amount such as 4,200, $4,200.50 or 48k; NaN for anything else. */
function amount(text: string): number {
  const m = text.trim().match(MONEY);
  if (!m) return NaN;
  const mult = { '': 1, k: 1e3, m: 1e6 }[m[3].toLowerCase() as '' | 'k' | 'm'];
  return Number(m[1].replace(/,/g, '') + (m[2] ?? '')) * mult;
}

/** Where `token` is in the line, searching from `after`. */
function span(raw: string, token: string, after: number): { from: number; to: number } {
  const from = raw.indexOf(token, after);
  return { from, to: from + token.length };
}

/** The holdings of a `holdings:` line, such as "SPY 120, TLT 50, QQQ 10", or the problem with the first that is wrong. */
function holdingsOf(raw: string, value: string, line: number): Holding[] | Diagnostic {
  if (value === '' || /^none$/i.test(value)) return [];
  const out: Holding[] = [];
  let at = raw.lastIndexOf(value);
  for (const item of value.split(BETWEEN_HOLDINGS).map((s) => s.trim())) {
    const where: { from?: number; to?: number } = item ? span(raw, item, at) : {};
    at = where.to ?? at;
    const m = item.match(/^(\S+)\s+(\S+)$/);
    const shares = m ? amount(m[2]) : NaN;
    if (!m || !TICKER.test(m[1]) || /[kKmM$]/.test(m[2]) || Number.isNaN(shares)) {
      return { line, message: `"${item}" is not a holding. Write each as a ticker and its shares, such as SPY 120`, ...where };
    }
    if (!(shares > 0)) return { line, message: `${m[1].toUpperCase()} has no shares: leave it out instead`, ...where };
    const ticker = m[1].toUpperCase();
    if (out.some((h) => h.ticker === ticker)) return { line, message: `${ticker} is listed twice`, ...where };
    out.push({ ticker, shares });
  }
  return out;
}

/** Reads one setting's value into `config`, or says what is wrong with it. */
function readSetting(config: AccountConfig, key: Setting, value: string, raw: string, line: number): Diagnostic | null {
  // The value ends the line, so its last appearance is the value itself, even in "name: name".
  const at = value ? span(raw, value, raw.lastIndexOf(value)) : {};
  const wrong = (message: string): Diagnostic => ({ line, message, ...at });
  switch (key) {
    case 'name':
      if (!value) return wrong('Write the name of the account after "name:"');
      config.name = value;
      return null;
    case 'holdings': {
      const h = holdingsOf(raw, value, line);
      if (!Array.isArray(h)) return h;
      config.holdings = h;
      return null;
    }
    case 'cash': {
      if (/^-/.test(value)) return wrong("Cash can't be below 0: the account holds no borrowed money");
      const cash = amount(value);
      if (Number.isNaN(cash)) return wrong(`"${value}" is not an amount of cash. Write it as 4,200 or 4200.50`);
      config.cash = cash;
      return null;
    }
    case 'capital at start': {
      const capital = amount(value);
      if (!(capital > 0)) return wrong(`"${value}" is not an amount above 0. Write the account's value on the day in fills from, such as 48,000`);
      config.capitalAtStart = capital;
      return null;
    }
    case 'whole shares':
      if (!/^(yes|no)$/i.test(value)) return wrong('whole shares is yes or no');
      config.wholeShares = value.toLowerCase() === 'yes';
      return null;
    case 'skip under': {
      const m = value.match(PERCENT);
      if (!m) return wrong(`"${value}" is not a share of the account. Write it as 1%, or 0% to make every order`);
      if (Number(m[1]) >= 100) return wrong('skip under must be under 100%');
      config.skipUnder = Number(m[1]) / 100;
      return null;
    }
    case 'fills': {
      const path = value.replace(/^\[\[(.*)\]\]$/, '$1').trim();
      if (!/\.csv$/i.test(path)) return wrong("fills takes the vault path of the broker's CSV file, such as Broker/schwab.csv");
      config.fills = path;
      return null;
    }
    case 'fills from': {
      const m = value.match(DATE);
      const t = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
      if (!m || new Date(t).getUTCDate() !== Number(m[3])) return wrong(`"${value}" is not a date. Write it as 2026-06-01`);
      config.fillsFrom = t;
      return null;
    }
    case 'fills columns': {
      const c = parseFillColumns(value);
      if (typeof c === 'string') return wrong(c);
      config.fillColumns = c;
      return null;
    }
  }
}

/**
 * Reads the lines of an `account` block: settings, and the strategies it follows as compare blocks list them, where 0%
 * lists a strategy without giving it any of the money. `config` and `entries` hold every line that was read, even when
 * `errors` is not empty.
 */
export function parseAccount(source: string): { config: AccountConfig; entries: CompareEntry[]; errors: Diagnostic[] } {
  const config: AccountConfig = { name: null, holdings: [], cash: 0, wholeShares: true, skipUnder: 0, fills: null, fillsFrom: null, capitalAtStart: null, fillColumns: null };
  const entries: CompareEntry[] = [];
  const errors: Diagnostic[] = [];
  const seen = new Map<Setting, number>();
  source.split(/\r?\n/).forEach((raw, i) => {
    const text = raw.trim();
    const line = i + 1;
    if (!text || text.startsWith('#')) return;
    const m = text.startsWith('[[') ? null : text.match(SETTING_LINE);
    if (m) {
      const key = SETTINGS.find((s) => s === m[1].toLowerCase().replace(/\s+/g, ' '));
      if (!key) {
        errors.push({ line, message: `"${m[1]}" is not a setting of an account. The settings are ${settingList()}` });
        return;
      }
      const before = seen.get(key);
      if (before !== undefined) {
        errors.push({ line, message: `${key} is already set on line ${before}` });
        return;
      }
      seen.set(key, line);
      const problem = readSetting(config, key, m[2].trim(), raw, line);
      if (problem) errors.push(problem);
      return;
    }
    if (!text.startsWith('[[') && !/\.md\b/i.test(text)) {
      errors.push({ line, message: NOT_A_LINE });
      return;
    }
    const r = parseLine(raw, line);
    if ('message' in r) errors.push(r);
    else entries.push(r);
  });

  errors.push(...duplicateEntries(entries));
  if (entries.length > MAX_ENTRIES) errors.push({ line: entries[MAX_ENTRIES].line, message: `An account follows at most ${MAX_ENTRIES} strategies` });
  if (entries.length === 0 && errors.length === 0) errors.push({ line: 1, message: 'Add the strategies the account follows, such as [[Trend following]] 60%' });
  errors.push(...weightProblems(entries));
  if (!seen.has('cash') && !seen.has('holdings')) errors.push({ line: 1, message: "Write the account's cash, its holdings or both, such as cash: 10,000" });
  if (config.fills !== null && !seen.has('fills from')) {
    errors.push({ line: seen.get('fills')!, message: 'fills needs a fills from line: the first day the account followed its strategies, such as fills from: 2026-06-01' });
  }
  return { config, entries, errors: errors.sort((a, b) => a.line - b.line) };
}

/** Each entry's share of the account: its weight, or an equal share of all of it when the block gives no weights. */
export function allocations(entries: CompareEntry[]): number[] {
  return entries.map((e) => e.weight ?? 1 / entries.length);
}

/** A strategy the account follows, run: its entry, the name it goes by, its share of the account and the run's output. */
export interface FollowedRun extends EntryRun {
  entry: CompareEntry;
  alloc: number;
}

/** Runs each entry's strategy, one after another, as a compare block does. Rejects as `runEntry` does, at the first entry that fails. */
export async function runAccount<F extends { basename: string }>(entries: CompareEntry[], host: CompareHost<F>): Promise<FollowedRun[]> {
  const shares = allocations(entries);
  const out: FollowedRun[] = [];
  for (const [i, entry] of entries.entries()) out.push({ entry, alloc: shares[i], ...(await runEntry(entry, host)) });
  return out;
}

// --- Orders --------------------------------------------------------------------------------------------------------

/** What the account's orders need from one strategy's run. */
export interface AccountStrategy {
  label: string;
  /** Its share of the money the strategies manage, as a fraction. */
  alloc: number;
  /** The run's equity and the time of its last bar. */
  equity: number;
  asOf: number;
  states: AssetState[];
  closeFill: boolean;
  rebalance: Rebalance;
  sizing: Sizing['k'];
  /** Its costs and slippage on a trade, as a fraction of the trade's value. */
  cost: number;
}

export function accountStrategy(label: string, alloc: number, out: Pick<RunOutput, 'spec' | 'backtest'>): AccountStrategy {
  const { run } = out.backtest;
  return {
    label,
    alloc,
    equity: run.equity[run.equity.length - 1],
    asOf: run.t[run.t.length - 1],
    states: run.states,
    closeFill: out.spec.fill === 'close',
    rebalance: out.spec.rebalance,
    sizing: out.spec.sizing.k,
    cost: (out.spec.costBps + out.spec.slippageBps) / 1e4,
  };
}

export type OrderKind = 'open' | 'close' | 'resize';

export interface AccountOrder {
  /** As the strategies spell it. */
  ticker: string;
  /** The last close, from the strategy whose prices end latest. */
  price: number;
  /** Shares held now, and the shares the strategies' positions after their orders come to at the account's size. */
  holding: number;
  target: number;
  /** Shares to buy (above 0) or sell (below 0), after the band, whole shares and the cash; 0 for none. */
  shares: number;
  /** Opening or closing a position follows a signal, and is never skipped as small; resizing one is. */
  kind: OrderKind;
  /** A resize smaller than `skip under` (or, in whole shares, one share or less) left out. */
  skipped: boolean;
  /** Cut so the buys cost no more than the cash and what the sales bring. */
  cut: boolean;
  /** Each strategy's own orders in money at the account's size, in the order of the strategies. */
  parts: number[];
  /**
   * The money it takes to bring the holding to the strategies' positions before their orders. The order before the band,
   * whole shares and the cash is `parts` and `drift` together.
   */
  drift: number;
  /** What trading the strategies' orders as one spares: the sum of their sizes less the size of their sum, in money and in their costs. */
  saved: number;
  savedCost: number;
}

export interface AccountPlan {
  /** Cash and the holdings of tickers a listed strategy trades, at the last closes: the money the strategies manage. */
  managed: number;
  /** Sales first, then purchases, then positions with nothing to do, each by ticker. */
  orders: AccountOrder[];
  /** Holdings of tickers no listed strategy trades, left as they are. */
  unmanaged: Holding[];
  /** Cash after the orders, at the last closes. */
  cashAfter: number;
  saved: number;
  savedCost: number;
  /** Plain sentences on what to keep in mind about these orders. */
  notes: string[];
}

/** Shares a strategy holds once its orders waiting for the next bar are made, at the sizes its last close gives them. */
export function sharesAfterOrders(st: AssetState, equity: number): number {
  if (!(st.lastClose > 0)) return 0;
  const bought = (st.targetWeight * equity) / st.lastClose;
  if (st.pending === 'sell') return 0;
  if (st.pending === 'buy') return bought;
  if (st.pending === 'add') return st.shares + bought;
  return st.shares;
}

const SIZING_WORDS: Record<Exclude<Sizing['k'], 'fixed'>, string> = { invvol: 'inverse volatility', risk: 'risk per trade' };

/**
 * Shares to 8 decimals, the finest that crypto exchanges trade. The noise of floating point (0.7999999999999998 for 0.8)
 * is dropped before `round` cuts, and adding 0 turns a -0 into 0.
 */
const fraction = (shares: number, round: (x: number) => number): number => round(Number((shares * 1e8).toPrecision(12))) / 1e8 + 0;

/**
 * The orders that bring the account to the strategies' positions. Each ticker's target is the sum over the strategies of
 * their share of the managed money times the share of their equity the ticker comes to after their orders.
 */
export function accountOrders(config: Pick<AccountConfig, 'holdings' | 'cash' | 'wholeShares' | 'skipUnder'>, strategies: AccountStrategy[]): AccountPlan {
  const n = strategies.length;
  const prices = new Map<string, { ticker: string; price: number; asOf: number }>();
  for (const s of strategies) {
    for (const st of s.states) {
      const key = st.name.toUpperCase();
      const known = prices.get(key);
      if (st.lastClose > 0 && (!known || s.asOf > known.asOf)) prices.set(key, { ticker: st.name, price: st.lastClose, asOf: s.asOf });
    }
  }
  const held = new Map(config.holdings.map((h) => [h.ticker.toUpperCase(), h.shares]));
  const managed = config.cash + config.holdings.reduce((sum, h) => sum + (prices.has(h.ticker) ? h.shares * prices.get(h.ticker)!.price : 0), 0);

  const rows = new Map<string, { target: number; parts: number[]; rates: number }>();
  for (const [key] of prices) rows.set(key, { target: 0, parts: new Array<number>(n).fill(0), rates: 0 });
  strategies.forEach((s, i) => {
    if (!(s.equity > 0)) return;
    for (const st of s.states) {
      const row = rows.get(st.name.toUpperCase());
      if (!row || !(st.lastClose > 0)) continue;
      const share = (s.alloc * managed * st.lastClose) / s.equity;
      const after = sharesAfterOrders(st, s.equity);
      row.target += share * after;
      row.parts[i] += share * (after - st.shares);
    }
  });

  const orders: AccountOrder[] = [];
  const notes: string[] = [];
  for (const [key, row] of rows) {
    const { ticker, price } = prices.get(key)!;
    const holding = held.get(key) ?? 0;
    const target = row.target / price;
    const own = row.parts.reduce((s, x) => s + x, 0);
    const gross = row.parts.reduce((s, x) => s + Math.abs(x), 0);
    if (holding === 0 && target === 0 && gross === 0) continue;
    const kind: OrderKind = holding === 0 ? 'open' : target === 0 ? 'close' : 'resize';
    const change = target - holding;
    const skipped =
      kind === 'resize' && config.skipUnder > 0 && (Math.abs(change) * price < config.skipUnder * managed || (config.wholeShares && Math.abs(change) <= 1));
    let shares = 0;
    if (!skipped) {
      if (kind === 'close') shares = -holding;
      // A fraction is cut towards 0, so no order goes past its target and buys stay within the money the targets share.
      else if (!config.wholeShares) shares = fraction(change, Math.trunc);
      // Rounding must never sell more than is held (10.6 shares with a target near 0.05 would round to a sale of 11), and adding 0 turns a -0 into 0.
      else shares = (kind === 'open' ? Math.round(target) : Math.max(Math.round(change), -holding)) + 0;
    }
    if (kind === 'open' && target > 0 && shares === 0 && !skipped) notes.push(`${ticker}: the strategies' position comes to under half a share, so it is not bought.`);
    const rate = gross > 0 ? row.parts.reduce((s, x, i) => s + Math.abs(x) * strategies[i].cost, 0) / gross : 0;
    const saved = gross - Math.abs(own);
    orders.push({ ticker, price, holding, target, shares, kind, skipped, cut: false, parts: row.parts, drift: change * price - own, saved, savedCost: saved * rate });
  }

  const sales = orders.reduce((s, o) => s + (o.shares < 0 ? -o.shares * o.price : 0), 0);
  const wanted = orders.reduce((s, o) => s + (o.shares > 0 ? o.shares * o.price : 0), 0);
  const available = config.cash + sales;
  let bought = wanted;
  if (wanted > available) {
    const f = Math.max(0, available) / wanted;
    bought = 0;
    for (const o of orders) {
      if (o.shares <= 0) continue;
      o.shares = config.wholeShares ? Math.floor(o.shares * f) : fraction(o.shares * f, Math.floor);
      o.cut = true;
      bought += o.shares * o.price;
    }
    notes.push(`The buys come to ${money(wanted)}, more than the cash and the sales bring (${money(available)}), so each is cut to fit.`);
  }

  for (const s of strategies) {
    if (s.rebalance !== 'never' && s.states.some((st) => st.long)) {
      notes.push(`${s.label} rebalances ${s.rebalance}. A rebalance due at the next open shows here a bar late, once its backtest has made it.`);
    }
    if (s.sizing !== 'fixed' && s.states.some((st) => st.pending === 'buy' || st.pending === 'add')) {
      notes.push(`${s.label} sizes positions by ${SIZING_WORDS[s.sizing]}, so the size of a new one here is an estimate from the last close.`);
    }
    if (s.closeFill) notes.push(`${s.label} fills at the close: what it holds here already includes what it traded at the last close.`);
  }

  const rank = (o: AccountOrder) => (o.shares < 0 ? 0 : o.shares > 0 ? 1 : 2);
  orders.sort((a, b) => rank(a) - rank(b) || a.ticker.localeCompare(b.ticker, 'en'));
  return {
    managed,
    orders,
    unmanaged: config.holdings.filter((h) => !prices.has(h.ticker)),
    cashAfter: config.cash + sales - bought,
    saved: orders.reduce((s, o) => s + o.saved, 0),
    savedCost: orders.reduce((s, o) => s + o.savedCost, 0),
    notes,
  };
}
