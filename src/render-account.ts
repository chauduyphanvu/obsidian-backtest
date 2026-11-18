// The `account` block: the orders that bring an account to what the strategies it follows hold together, how to split
// it between them, and the broker's fills set against the strategies' trades. The plugin runs the strategies and reads the
// files; account.ts, allocate.ts and fills.ts do the working out.

import { accountOrders, accountStrategy, allocations, parseAccount, type AccountConfig, type AccountPlan, type FollowedRun } from './account.ts';
import { weightDecimals } from './allocate.ts';
import { alignCurves, cashIndex, type Aligned, type CompareEntry } from './compare.ts';
import { h } from './dom.ts';
import {
  fillColumnsText,
  headerGuess,
  matchFills,
  rawPrices,
  readFills,
  type FillColumns,
  type FillRole,
  type FillsRead,
  type Followed,
  type LeftOut,
  type MatchRow,
  type RawPrices,
  type Reconciliation,
} from './fills.ts';
import { DAY, isIntraday, isoDate, minus, money, plural, price, shareCount, stamp } from './format.ts';
import { renderCompareErrors, renderCompareMessage } from './render-compare.ts';
import { renderSplit } from './render-split.ts';
import type { AssetRef, Bars } from './types.ts';

export interface AccountHost {
  /** Runs the strategies the block lists, one after another (runAccount); rejects with a message naming the line that failed. */
  run(entries: CompareEntry[]): Promise<FollowedRun[]>;
  /** The text of the file at a vault path; rejects with a message fit to show when there is none. */
  read(path: string): Promise<string>;
  /** Daily prices as they traded (Runner.loadRaw). */
  raw(refs: AssetRef[]): Promise<{ data: Map<string, Bars>; warnings: string[] }>;
  /** Writes whole percentages on the block's strategy lines (1-based, as CompareEntry.line); null when the block's place in its note is not known. */
  weights: ((weights: { line: number; percent: number }[]) => Promise<void>) | null;
  /** Writes a setting into the block; null likewise. */
  setting: ((key: string, value: string) => Promise<void>) | null;
}

/** An amount of money to the cent: $1,234.56, −$12.30. */
export const dollars = (x: number): string => minus((Math.round(x * 100) / 100 + 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const signedMoney = (x: number): string => `${x > 0 ? '+' : x < 0 ? '−' : ''}${money(Math.abs(x))}`;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// --- Orders ----------------------------------------------------------------------------------------------------------

export interface OrderRow {
  ticker: string;
  /** What to do: "Buy", "Sell all", or why nothing is done. */
  order: string;
  shares: string;
  price: string;
  /** The order's value at the last close; empty for none. */
  value: string;
  /** Shares held now and those the strategies' positions come to. */
  holding: string;
  /** Each strategy's own order at the account's size, and the drift of the holding from their positions. */
  from: string;
  /** Above 0 for a purchase, below for a sale, 0 for none. */
  side: number;
}

/** The rows of the orders table, in the plan's order: sales, purchases, then positions with nothing to do. */
export function orderRows(plan: AccountPlan, labels: string[]): OrderRow[] {
  return plan.orders.map((o) => {
    let order = o.shares > 0 ? 'Buy' : o.shares < 0 ? (o.kind === 'close' ? 'Sell all' : 'Sell') : o.skipped ? 'Skip: small' : 'Nothing to do';
    if (o.cut) order += ', cut to the cash';
    const from = o.parts.flatMap((x, i) => (Math.abs(x) >= 0.5 ? [`${labels[i]} ${signedMoney(x)}`] : []));
    if (Math.abs(o.drift) >= 0.5) from.push(`drift ${signedMoney(o.drift)}`);
    return {
      ticker: o.ticker,
      order,
      shares: o.shares === 0 ? '' : shareCount(Math.abs(o.shares)),
      price: price(o.price),
      value: o.shares === 0 ? '' : money(Math.abs(o.shares) * o.price),
      holding: `${shareCount(o.holding)} → ${shareCount(Number(o.target.toFixed(4)))}`,
      from: from.join(', '),
      side: Math.sign(o.shares),
    };
  });
}

/** The sentences under the orders: what the strategies manage, what netting spared, the cash after, what is left alone, and the plan's notes. */
export function planLines(plan: AccountPlan): string[] {
  const out = [`The strategies manage ${money(plan.managed)}: the cash and the holdings of the tickers they trade, at the last closes. Cash after the orders: ${money(plan.cashAfter)}.`];
  if (plan.saved >= 0.5) out.push(`Trading their orders as one, rather than each strategy on its own, spares ${money(plan.saved)} of trades and ${dollars(plan.savedCost)} of their costs.`);
  if (plan.unmanaged.length) out.push(`Left as they are, as no strategy listed trades them: ${plan.unmanaged.map((x) => `${x.ticker} ${shareCount(x.shares)}`).join(', ')}.`);
  return [...out, ...plan.notes];
}

/** When the orders are for: the strategies' last bars, said once when they agree. */
export function asOfLine(runs: { label: string; asOf: number }[]): string {
  const at = (t: number) => stamp(t, isIntraday([t]));
  const times = new Set(runs.map((r) => r.asOf));
  if (times.size === 1) return `For the next open, from the strategies' last bar, ${at(runs[0].asOf)}.`;
  return `For the next open, from each strategy's last bar: ${runs.map((r) => `${r.label} ${at(r.asOf)}`).join(', ')}.`;
}

// --- Fills -----------------------------------------------------------------------------------------------------------

export interface FillsSetup {
  /** Each strategy, with its own bars of the tickers it trades. */
  followed: Followed[];
  /** Each traded ticker's bars, from the strategy whose prices for it end latest: its days' ranges, when they are as traded, and its last price. */
  bars: Map<string, Bars>;
  last: Record<string, number>;
  /** The tickers whose prices are adjusted for later dividends and splits, Yahoo's and Tiingo's, and where they came from. */
  adjusted: Map<string, AssetRef>;
}

/** What setting fills against the strategies needs from their runs. */
export function fillsSetup(runs: Pick<FollowedRun, 'label' | 'alloc' | 'out'>[]): FillsSetup {
  const bars = new Map<string, Bars>();
  const adjusted = new Map<string, AssetRef>();
  const followed: Followed[] = [];
  for (const { label, alloc, out } of runs) {
    const { run } = out.backtest;
    const own = new Map(out.spec.universe.flatMap((a) => (out.data.has(a.name) ? [[a.name, out.data.get(a.name)!] as const] : [])));
    followed.push({ label, alloc, log: run.fills, t: run.t, equity: run.equity, bars: own, closeFill: out.spec.fill === 'close' });
    for (const a of out.spec.universe) {
      const b = out.data.get(a.name);
      if (!b || b.t.length === 0) continue;
      const known = bars.get(a.name);
      if (!known || b.t[b.t.length - 1] > known.t[known.t.length - 1]) bars.set(a.name, b);
      // Tiingo stands in for Yahoo when Yahoo fails, so where the prices came from is the run's, not the spec's.
      const source = out.prices.find((p) => p.name === a.name)?.source ?? a.source;
      if (source === 'yahoo' || source === 'tiingo') adjusted.set(a.name, { name: a.name, source, id: a.id });
    }
  }
  return {
    followed,
    bars,
    last: Object.fromEntries([...bars].map(([name, b]) => [name, b.c[b.c.length - 1]])),
    adjusted,
  };
}

/** Bars of a day each: none shorter, and some a day apart. */
const daily = (b: Bars) => !isIntraday(b.t) && b.t.some((t, i) => i > 0 && t - b.t[i - 1] === DAY);

/**
 * The days each ticker traded on, which lateness is counted in: those of its prices as traded where they were loaded
 * (`raw`), else those of a strategy's own daily bars of it. A ticker with neither, such as one only weekly strategies
 * trade, is left to matchFills, which counts Monday to Friday.
 */
export function tradingDays(setup: Pick<FillsSetup, 'followed' | 'bars'>, raw: Map<string, Bars>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const ticker of setup.bars.keys()) {
    const own = setup.followed.map((f) => f.bars?.get(ticker)).find((b) => b !== undefined && daily(b));
    const from = raw.get(ticker) ?? own;
    if (from) out[ticker] = [...new Set(from.t.map((t) => Math.floor(t / DAY) * DAY))];
  }
  return out;
}

/** The tickers to load prices as they traded for: the adjusted ones that you or the strategies traded from `from` on. */
export function rawWanted(setup: FillsSetup, fills: { date: number; ticker: string }[], from: number): AssetRef[] {
  const traded = new Set(fills.filter((f) => f.date >= from).map((f) => f.ticker));
  for (const s of setup.followed) s.log.t.forEach((t, j) => t >= from && traded.add(s.log.asset[j]));
  return [...setup.adjusted.values()].filter((r) => traded.has(r.name));
}

const LEFT_WORDS: Record<LeftOut, [string, string]> = {
  dividends: ['dividend', 'dividends'],
  reinvestments: ['reinvestment', 'reinvestments'],
  transfers: ['transfer', 'transfers'],
  other: ['other row', 'other rows'],
};
/** Rows that could not be read are listed up to this many. */
const UNREAD_SHOWN = 3;
const UNTRADED_SHOWN = 6;

/** No row of the file read as a trade, though there were rows: most likely the wrong columns, so nothing is compared. */
export const readNone = (read: FillsRead): boolean => read.fills.length === 0 && read.untraded.length === 0 && read.unread.length > 0;

/** What was read from the broker's file and what was left out. */
export function readLines(read: FillsRead): string[] {
  const as = read.format ? `as ${/^[aeiou]/i.test(read.format) ? 'an' : 'a'} ${read.format} export` : 'by the names of its columns';
  const out = [`Read ${plural(read.fills.length, 'purchase or sale', 'purchases and sales')} ${as}.`];
  const left = (Object.keys(LEFT_WORDS) as LeftOut[]).filter((k) => read.left[k] > 0).map((k) => plural(read.left[k], ...LEFT_WORDS[k]));
  if (left.length) out.push(`Left out, as they are not purchases or sales of shares: ${left.join(', ')}.`);
  if (read.untraded.length) {
    const shown = read.untraded.slice(0, UNTRADED_SHOWN).map((u) => `${u.ticker} (${u.rows})`);
    const more = read.untraded.length - shown.length;
    out.push(`Left out, as no strategy listed trades them: ${shown.join(', ')}${more > 0 ? ` and ${plural(more, 'other')}` : ''}.`);
  }
  if (read.unread.length) {
    const shown = read.unread.slice(0, UNREAD_SHOWN).map((u) => `line ${u.line}: ${u.why}`);
    out.push(`${plural(read.unread.length, 'row')} could not be read: ${shown.join('; ')}${read.unread.length > UNREAD_SHOWN ? '; …' : ''}.`);
  }
  if (readNone(read)) out.push('As no row could be read as a purchase or a sale, nothing is compared. Check which column holds each part of a trade.');
  return out;
}

/** The sentence at the top of the fills: what not following the rules cost since the day the account started following them. */
export function costHeadline(rec: Pick<Reconciliation, 'rows' | 'total'>, from: number): string {
  const since = isoDate(from);
  if (rec.rows.length === 0) return `Neither the strategies nor you traded since ${since}.`;
  if (Math.abs(rec.total) < 0.005) return `Not following the rules cost nothing since ${since}.`;
  return rec.total > 0 ? `Not following the rules cost ${dollars(rec.total)} since ${since}.` : `Not following the rules made ${dollars(-rec.total)} since ${since}.`;
}

/** The four parts the total is the sum of, each with what it is. */
export function costParts(rec: Pick<Reconciliation, 'parts'>): { name: string; value: string; what: string }[] {
  return [
    { name: 'Slippage', value: dollars(rec.parts.slippage), what: 'your prices against the strategies’ on the same day' },
    { name: 'Fees', value: dollars(rec.parts.fees), what: 'commissions and fees in your file' },
    { name: 'Late fills', value: dollars(rec.parts.late), what: 'your prices against the strategies’ for fills on a later day' },
    { name: 'Trades not made', value: dollars(rec.parts.skipped), what: 'what they would have made by the last close; a loss avoided counts below 0' },
  ];
}

/** What to keep in mind about the comparison: sizes, fills left out of it, trades still waiting. */
export function matchNotes(rec: Reconciliation, from: number): string[] {
  const out = ['The total is the sum of these parts, not a second run of the whole account: a trade of yours that matches none of the strategies’ counts only its fees.'];
  if (!rec.sized) out.push('Without capital at start, sizes are not compared and trades not made are not counted in money.');
  const outside = rec.rows.filter((r) => r.outside).length;
  if (outside) out.push(`${plural(outside, 'fill')} of yours ${outside === 1 ? 'is' : 'are'} more than 3% outside the day’s range as it traded, most likely from a split, and ${outside === 1 ? 'is' : 'are'} not compared on price.`);
  const unpriced = rec.rows.filter((r) => r.unpriced && r.yours).length;
  if (unpriced) out.push(`${plural(unpriced, 'fill')} ${unpriced === 1 ? 'is' : 'are'} not compared on price, as the prices that day as they traded are not known.`);
  const waiting = rec.rows.filter((r) => r.class === 'waiting').length;
  if (waiting) out.push(`${plural(waiting, 'trade')} of the strategies ${waiting === 1 ? 'is' : 'are'} still waiting: a fill in the next days counts as late.`);
  if (rec.before) out.push(`${plural(rec.before, 'fill')} before ${isoDate(from)} ${rec.before === 1 ? 'is' : 'are'} left out.`);
  return out;
}

const CLASS_WORDS: Record<MatchRow['class'], string> = {
  'on time': 'On time',
  partial: 'Partial',
  oversized: 'Oversized',
  late: 'Late',
  skipped: 'Not made',
  waiting: 'Waiting',
  'off-plan': 'Off plan',
};

/**
 * The cells of one row: day, ticker, how it went, the strategies' trade (the part of it this row covers), yours, your price
 * against theirs, and its cost.
 */
export function matchCells(r: MatchRow): string[] {
  const side = (s: 'buy' | 'sell') => (s === 'buy' ? 'Buy' : 'Sell');
  const known = (x: number) => (Number.isFinite(x) ? price(x) : 'unknown');
  const model = r.model ? `${side(r.model.side)}${r.model.quantity === null ? '' : ` ${shareCount(Number(r.model.quantity.toFixed(4)))}`} at ${known(r.model.price)}` : '–';
  const yours = r.yours ? `${side(r.yours.side)} ${shareCount(r.yours.quantity)} at ${price(r.yours.price)}` : '–';
  let how = r.class === 'partial' ? 'Partial: the rest not made' : CLASS_WORDS[r.class];
  if (r.daysLate !== null) how += ` by ${plural(r.daysLate, 'trading day')}`;
  if ((r.class === 'skipped' || r.class === 'partial') && r.move !== null && Number.isFinite(r.move)) how += `, would have ${r.move >= 0 ? 'made' : 'lost'} ${(Math.abs(r.move) * 100).toFixed(1)}%`;
  const vs = r.bps !== null ? `${r.bps > 0 ? '+' : ''}${minus(r.bps.toFixed(1))} bps` : r.outside ? 'outside the day' : '';
  const cost = r.class === 'waiting' ? '' : dollars(r.slippage + r.late + r.skipped + r.fees);
  return [isoDate((r.model ?? r.yours)!.day), r.ticker, how, model, yours, vs, cost];
}

/** The cells of one ticker: how its trades went, then slippage, fees, late fills and trades not made in money. */
export function tickerCells(t: Reconciliation['tickers'][number]): string[] {
  const counts = (Object.keys(CLASS_WORDS) as MatchRow['class'][]).filter((c) => t.counts[c] > 0).map((c) => `${t.counts[c]} ${CLASS_WORDS[c].toLowerCase()}`);
  const slippage = `${dollars(t.slippage)}${t.bps === null ? '' : ` (${minus(t.bps.toFixed(1))} bps)`}`;
  return [t.ticker, counts.join(', '), slippage, dollars(t.fees), dollars(t.late), dollars(t.skipped)];
}

// --- Naming the columns by hand ---------------------------------------------------------------------------------------

const PICKS: readonly { role: FillRole; label: string; none?: string }[] = [
  { role: 'date', label: 'Date' },
  { role: 'ticker', label: 'Ticker' },
  { role: 'side', label: 'Buy or sell', none: 'none: the quantity’s sign says' },
  { role: 'quantity', label: 'Quantity' },
  { role: 'price', label: 'Price' },
  { role: 'fees', label: 'Fees', none: 'none' },
];
const NEEDED: readonly FillRole[] = ['date', 'ticker', 'quantity', 'price'];

/** Which column of `header` each part is in; -1 for none. */
export type Picks = Record<FillRole, number>;

/** The `fills columns` text for the columns picked, or what is still missing. */
export function picksText(header: string[], picks: Picks): { text: string } | { missing: string[] } {
  const missing = NEEDED.filter((r) => picks[r] < 0);
  if (missing.length) return { missing };
  const at = (r: FillRole) => (picks[r] >= 0 ? header[picks[r]] : null);
  const columns: Partial<FillColumns> = { date: at('date'), ticker: at('ticker'), side: at('side'), quantity: at('quantity'), price: at('price'), fees: picks.fees >= 0 ? [header[picks.fees]] : [] };
  return { text: fillColumnsText(columns) };
}

function columnForm(parent: HTMLElement, text: string, saved: Partial<FillColumns>, save: (value: string) => Promise<void>): void {
  const guess = headerGuess(text, saved);
  if (!guess) {
    h(parent, 'div', 'bt-note', 'No line of the file has more than one column. Is it the CSV file your broker exports?');
    return;
  }
  const { header } = guess;
  const labels = header.map((name, i) => (name === '' || header.indexOf(name) !== header.lastIndexOf(name) ? `${name || 'no name'} (column ${i + 1})` : name));
  const picks: Picks = { ...guess.at, fees: guess.fees[0] ?? -1 };
  const form = h(parent, 'div', 'bt-acct-form');
  h(form, 'div', 'bt-note', 'Say which column holds each part of a trade. The choice is saved in the block as a fills columns line.');
  const grid = h(form, 'div', 'bt-acct-fields');
  const button = h(form, 'button', 'bt-button mod-cta', 'Save these columns in the block');
  const said = h(form, 'div', 'bt-note');
  said.setAttribute('role', 'status');
  const refresh = () => {
    const r = picksText(header, picks);
    button.disabled = 'missing' in r;
    said.textContent = 'missing' in r ? `Choose the ${r.missing.join(', ')} ${r.missing.length === 1 ? 'column' : 'columns'}.` : `It will read: fills columns: ${r.text}`;
  };
  for (const p of PICKS) {
    const field = h(grid, 'label', 'bt-acct-field');
    h(field, 'span', 'bt-acct-label', p.label);
    const select = h(field, 'select', 'dropdown');
    h(select, 'option', undefined, p.none ?? 'Choose a column').value = '-1';
    labels.forEach((label, i) => (h(select, 'option', undefined, label).value = String(i)));
    select.value = String(picks[p.role]);
    select.addEventListener('change', () => {
      picks[p.role] = Number(select.value);
      refresh();
    });
  }
  button.addEventListener('click', () => {
    const r = picksText(header, picks);
    if ('missing' in r) return;
    button.disabled = true;
    said.textContent = 'Saving…';
    save(r.text).then(
      () => (said.textContent = 'Saved. The block reads the file again with these columns.'),
      (e: unknown) => {
        button.disabled = false;
        said.textContent = message(e);
      },
    );
  });
  refresh();
}

// --- Drawing ---------------------------------------------------------------------------------------------------------

function table(parent: HTMLElement, cls: string, head: string[], rows: string[][], numeric: (col: number) => boolean, rowClass?: (i: number) => string | undefined): void {
  const t = h(h(parent, 'div', 'bt-scroll'), 'table', `bt-table ${cls}`);
  const tr = h(h(t, 'thead'), 'tr');
  head.forEach((name, c) => h(tr, 'th', numeric(c) ? 'bt-num' : undefined, name));
  const body = h(t, 'tbody');
  rows.forEach((cells, i) => {
    const row = h(body, 'tr', rowClass?.(i));
    cells.forEach((cell, c) => h(row, 'td', numeric(c) ? 'bt-num' : undefined, cell));
  });
}

function drawOrders(root: HTMLElement, config: AccountConfig, runs: FollowedRun[]): void {
  const strategies = runs.map((r) => accountStrategy(r.label, r.alloc, r.out));
  const plan = accountOrders(config, strategies);
  h(root, 'div', 'bt-acct-heading', 'Orders for this account');
  h(root, 'div', 'bt-sub', asOfLine(strategies));
  const rows = orderRows(plan, runs.map((r) => r.label));
  if (rows.length === 0) h(root, 'div', 'bt-note', 'The strategies hold nothing and the account holds none of their tickers: there is nothing to do.');
  else {
    table(
      root,
      'bt-acct-orders',
      ['Ticker', 'Order', 'Shares', 'Last close', 'Value', 'Held → target', 'From'],
      rows.map((r) => [r.ticker, r.order, r.shares, r.price, r.value, r.holding, r.from]),
      (c) => c >= 2 && c <= 5,
      (i) => (rows[i].side > 0 ? 'bt-acct-buy' : rows[i].side < 0 ? 'bt-acct-sell' : 'bt-acct-none'),
    );
  }
  for (const line of planLines(plan)) h(root, 'div', 'bt-note', line);
}

function drawSplit(root: HTMLElement, entries: CompareEntry[], runs: FollowedRun[], host: AccountHost): void {
  let aligned: Aligned;
  try {
    aligned = alignCurves(runs.map((r) => ({ label: r.label, t: r.out.backtest.run.t, equity: r.out.backtest.run.equity, cash: cashIndex(r.out.backtest.run.cashReturn) })));
  } catch (e) {
    h(root, 'div', 'bt-note', `How to split can't be worked out: ${message(e)}.`);
    return;
  }
  const write = host.weights;
  renderSplit(root, {
    aligned,
    labels: runs.map((r) => r.label),
    weights: allocations(entries),
    decimals: weightDecimals(entries.flatMap((e) => (e.weight === null ? [] : [e.weight]))),
    use: write ? (percents) => write(entries.map((e, i) => ({ line: e.line, percent: percents[i] }))) : null,
  });
}

async function drawFills(box: HTMLElement, config: AccountConfig, runs: FollowedRun[], host: AccountHost, stopped: () => boolean): Promise<void> {
  const path = config.fills!;
  const from = config.fillsFrom!;
  const say = (text: string, cls = 'bt-note') => h(box, 'div', cls, text);
  let text: string;
  try {
    text = await host.read(path);
  } catch (e) {
    if (!stopped()) say(message(e), 'bt-warning');
    return;
  }
  const setup = fillsSetup(runs);
  const read = readFills(text, [...setup.bars.keys()], config.fillColumns ?? {});
  if (stopped()) return;
  if (!read.ok) {
    say(read.reason, 'bt-warning');
    const save = host.setting;
    if (save) columnForm(box, text, config.fillColumns ?? {}, (value) => save('fills columns', value));
    return;
  }
  const wanted = read.fills.some((f) => f.date >= from) ? rawWanted(setup, read.fills, from) : [];
  let raw: RawPrices | undefined;
  let asTraded = new Map<string, Bars>();
  if (wanted.length) {
    const loading = say('Loading the prices as they traded…');
    const got = await host.raw(wanted);
    if (stopped()) return;
    loading.remove();
    for (const w of got.warnings) say(w, 'bt-warning');
    asTraded = got.data;
    raw = rawPrices(setup.bars, asTraded, new Set(setup.adjusted.keys()));
  }
  const rec = matchFills(setup.followed, read.fills, { from, capital: config.capitalAtStart, last: setup.last, days: tradingDays(setup, asTraded), raw });

  for (const line of readLines(read)) say(line);
  if (readNone(read)) {
    if (host.setting) columnForm(box, text, config.fillColumns ?? {}, (value) => host.setting!('fills columns', value));
    return;
  }
  say(costHeadline(rec, from), 'bt-acct-total');
  if (rec.rows.length === 0) return;
  const parts = h(box, 'dl', 'bt-acct-parts');
  for (const p of costParts(rec)) {
    const item = h(parts, 'div', 'bt-acct-part');
    h(item, 'dt', undefined, p.name);
    h(item, 'dd', 'bt-num', p.value);
    item.title = p.what;
  }
  table(box, 'bt-acct-tickers', ['Ticker', 'Trades', 'Slippage', 'Fees', 'Late fills', 'Not made'], rec.tickers.map(tickerCells), (c) => c >= 2);
  for (const line of matchNotes(rec, from)) say(line);

  if (rec.suggested.length) {
    say('The median slippage of each strategy’s fills, as a line for its block, so its backtest pays what you pay:');
    const list = h(box, 'ul', 'bt-acct-suggested');
    for (const s of rec.suggested) {
      const li = h(list, 'li');
      li.append(`${runs[s.strategy].label}: `);
      h(li, 'code', undefined, s.line);
      li.append(` from ${plural(s.fills, 'fill')}`);
    }
  }

  const every = h(box, 'details', 'bt-details bt-acct-every');
  h(every, 'summary', undefined, `Every trade (${rec.rows.length.toLocaleString('en-US')})`);
  table(every, 'bt-acct-trades', ['Day', 'Ticker', 'How', 'The strategies', 'Yours', 'Against theirs', 'Cost'], rec.rows.map(matchCells), (c) => c >= 5, (i) => `bt-acct-${rec.rows[i].class.replace(' ', '-')}`);
}

/** Draws an `account` block into `parent` (which the caller has emptied). Returns a cleanup function. */
export function renderAccount(parent: HTMLElement, source: string, host: AccountHost): () => void {
  const { config, entries, errors } = parseAccount(source);
  if (errors.length) {
    renderCompareErrors(parent, errors, source, "This account can't be worked out yet");
    return () => {};
  }
  let stopped = false;
  renderCompareMessage(parent, `Running ${plural(entries.length, 'strategy', 'strategies')}…`);
  void (async () => {
    let runs: FollowedRun[];
    try {
      runs = await host.run(entries);
    } catch (e) {
      if (stopped) return;
      parent.replaceChildren();
      renderCompareMessage(parent, message(e));
      return;
    }
    if (stopped) return;
    parent.replaceChildren();
    const root = h(parent, 'div', 'bt-root bt-acct');
    h(root, 'div', 'bt-title', config.name ?? 'Account');
    for (const w of new Set(runs.flatMap((r) => r.out.warnings))) h(root, 'div', 'bt-warning', w);
    drawOrders(root, config, runs);
    if (entries.length > 1) drawSplit(root, entries, runs, host);
    if (config.fills === null) return;
    h(root, 'div', 'bt-acct-heading', 'Your fills against the signals');
    const box = h(root, 'div', 'bt-acct-fills');
    await drawFills(box, config, runs, host, () => stopped);
  })().catch((e: unknown) => {
    if (stopped) return;
    h(parent, 'div', 'bt-warning', message(e));
  });
  return () => {
    stopped = true;
  };
}
