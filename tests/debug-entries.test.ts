import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type Backtest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import type { Trade } from '../src/engine.ts';
import { cellText, debugColumns, debugCsv, debugRange, debugRows, positionWords, type DebugRow } from '../src/debug.ts';
import { price } from '../src/format.ts';
import * as ind from '../src/indicators.ts';
import { makeRng } from '../src/rng.ts';
import type { Bars } from '../src/types.ts';
import { bars, near } from './helpers.ts';

function run(src: string, data: Record<string, Bars>): Backtest {
  const { spec, errors } = parseSpec(src);
  assert.deepEqual(errors, []);
  return runBacktest(spec!, new Map(Object.entries(data)));
}
const rowsOf = (bt: Backtest, asset = 'A'): DebugRow[] => debugRows(bt, asset, 0, debugRange(bt, asset).count);
const kinds = (row: DebugRow) => row.events.map((e) => e.k);
const heads = (bt: Backtest) => debugColumns(bt, 'A').map((c) => `${c.group}:${c.text}`);
const colOf = (bt: Backtest, text: string) => {
  const n = debugColumns(bt, 'A').findIndex((c) => c.text === text);
  assert.ok(n >= 0, `no column for ${text}`);
  return n;
};

// Rises 4% a bar for a while, so each add rule (3% above the last entry) holds, then falls through the stop.
const CLOSES = [100, 100, 100, 100, 100, 104, 105, 109, 110, 114, 113, 118, 112, 111, 100, 95, 90, 95, 100];
const THREE = 'universe: A\ncapital: 10000\ncosts: 5 bps\ncommission: 1\nentries: 3\nstop loss: 8%\nbuy when close > sma(5)\nadd when close > last entry price * 1.03\nsell when close < sma(5) * 0.97';

test('the add rule\'s parts are columns after the sell rule\'s, read while a position has room for another entry', () => {
  const bt = run(THREE, { A: bars(CLOSES) });
  assert.deepEqual(heads(bt), ['buy:close > sma(5)', 'sell:close < sma(5) * 0.97', 'add:close > last entry price * 1.03']);
  const rows = rowsOf(bt);
  const add = (r: DebugRow) => r.cells[2];
  // Flat: a dash. Entry 1 made: its two values. With all three made: a dash again.
  assert.deepEqual(rows.map((r) => r.entries), [0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 3, 3, 0, 0, 0, 0, 0]);
  assert.deepEqual(rows.map((r) => add(r).outcome === null), rows.map((r) => r.entries === 0 || r.entries === 3));
  assert.deepEqual(rows.map((r) => r.cells[1].outcome === null), rows.map(() => false));
  // The values are the close and the latest entry's fill price times 1.03: entry 1 filled at 104, entry 2 at 109.
  assert.equal(add(rows[6]).a, 105);
  assert.ok(near(add(rows[6]).b, 104 * 1.03));
  assert.ok(near(add(rows[8]).b, 109 * 1.03));
  assert.equal(cellText(debugColumns(bt, 'A')[2], add(rows[6])).main, '105 > 107.12');
  assert.deepEqual(rows.slice(6, 12).map((r) => add(r).outcome), ['no', 'yes', 'no', 'yes', null, null]);
});

/** What the rules read of a position at a bar, worked out from the trade's entries alone: how many entries had filled, the latest price, the shares-weighted average. */
function oracle(trade: Trade, t: number, atClose: boolean) {
  const made = trade.entries!.filter((e) => (atClose ? e.t < t : e.t <= t));
  const shares = made.reduce((s, e) => s + e.shares, 0);
  return { entries: made.length, last: made[made.length - 1].price, average: made.reduce((s, e) => s + e.price * e.shares, 0) / shares };
}

for (const fill of ['', 'fill: close\n']) {
  test(`entries made, last entry price and entry price are valued at each bar from the entries made by then${fill ? ', with fill: close' : ''}`, () => {
    const rng = makeRng(8);
    let c = 100;
    const walk = bars(Array.from({ length: 400 }, () => (c *= 1 + (rng.next() - 0.47) * 0.04)));
    // The sell rule's last three parts can never hold, so each column just shows the value it reads.
    const src = `universe: A\ncapital: 10000\nentries: 4\n${fill}stop loss: 20%\nbuy when close > sma(10)\nadd when close > last entry price * 1.03\nsell when close < sma(10) * 0.99 or entries made > 99 or last entry price > 1000000000 or entry price > 1000000000`;
    const bt = run(src, { A: walk });
    const counts = new Set(bt.run.trades.map((t) => t.entries!.length));
    assert.deepEqual([...counts].sort(), [1, 2, 3, 4]);
    const [madeC, lastC, avgC] = ['entries made > 99', 'last entry price > 1000000000', 'entry price > 1000000000'].map((t) => colOf(bt, t));
    const rows = rowsOf(bt);
    const atClose = fill !== '';
    let checked = 0;
    for (const trade of bt.run.trades) {
      for (const r of rows) {
        const held = r.t >= trade.entryT && (trade.reason === 'open' || r.t < trade.exitT);
        // The rules are read at the close; with fill: close a position bought at this close is not yet there to read.
        if (!held || (atClose && r.t === trade.entryT)) continue;
        const want = oracle(trade, r.t, atClose);
        assert.equal(r.cells[madeC].a, want.entries, `entries made at bar ${r.index}`);
        assert.ok(near(r.cells[lastC].a, want.last, 1e-9), `last entry price at bar ${r.index}: ${r.cells[lastC].a} against ${want.last}`);
        assert.ok(near(r.cells[avgC].a / want.average, 1, 1e-9), `entry price at bar ${r.index}: ${r.cells[avgC].a} against ${want.average}`);
        checked++;
      }
    }
    assert.ok(checked > 100, `${checked} bars checked`);
    // The bars where no position was read show a dash for each of them.
    const flat = rows.filter((r) => !r.readHeld);
    assert.ok(flat.length > 50 && flat.every((r) => [madeC, lastC, avgC].every((n) => r.cells[n].outcome === null)));
  });
}

test('what happened names each entry: the add rule held, the fill, the average price and the stop that moved with it', () => {
  const bt = run(THREE, { A: bars(CLOSES) });
  const [trade] = bt.run.trades;
  assert.deepEqual(trade.entries!.map((e) => e.price), [104, 109, 114]);
  const rows = rowsOf(bt);
  const [one, two] = trade.why!.adds!;
  assert.equal(rows[5].what, 'Buy rule held: bought entry 1 of 3 at the next open (2020-01-07) at 104.00.');
  assert.equal(rows[6].what, 'Bought entry 1 of 3 at the open at 104.00.');
  assert.equal(rows[7].what, 'Add rule held: added entry 2 of 3 at the next open (2020-01-09) at 109.00. Buy rule held, but a long position was open.');
  assert.equal(
    rows[8].what,
    `Added entry 2 of 3 at the open at 109.00. Average entry price changed to ${price(one.average)}, stop loss moved to ${price(one.stopLoss!)}. Buy rule held, but a long position was open.`,
  );
  assert.equal(
    rows[10].what,
    `Added entry 3 of 3 at the open at 114.00. Average entry price changed to ${price(two.average)}, stop loss moved to ${price(two.stopLoss!)}. Buy rule held, but a long position was open.`,
  );
  // The stop that moved is the average entry price less 8%, and it is what stopped the position out.
  assert.ok(near(two.stopLoss!, two.average * 0.92, 1e-9));
  assert.equal(rows[14].what, `Stopped out at ${price(trade.exitPrice)}.`);
  assert.ok(near(trade.exitPrice, two.stopLoss!, 1e-9));
  // The rule held again with every entry made.
  assert.equal(rows[11].what, 'Buy rule held, but a long position was open. Add rule held, but the position had all its entries.');
  assert.deepEqual(kinds(rows[8]), ['add', 'long']);
  assert.deepEqual(rows.map((r) => positionWords(r)), [
    ...Array(6).fill('Flat'),
    ...[1, 1, 2, 2, 3, 3, 3, 3].map((n, i) => `Long, ${n} of 3 entries, ${rows[6 + i].shares.toLocaleString('en-US', { maximumFractionDigits: 4 })} shares`),
    ...Array(5).fill('Flat'),
  ]);
  assert.ok(rows[6].shares < rows[8].shares && rows[8].shares < rows[10].shares);
  assert.ok(near(rows[10].shares, trade.entries!.reduce((s, e) => s + e.shares, 0), 1e-9));
});

test('with fill: close an add is decided and filled at one close, after the rule was read with the earlier entries', () => {
  const bt = run(THREE.replace('entries: 3', 'entries: 3\nfill: close'), { A: bars(CLOSES) });
  const [trade] = bt.run.trades;
  const rows = rowsOf(bt);
  const at = (t: number) => rows.find((r) => r.t === t)!;
  assert.equal(trade.entries!.length, 3);
  trade.entries!.slice(1).forEach((e, k) => {
    const row = at(e.t);
    assert.ok(row.events.some((x) => x.k === 'add' && x.stage === 'both' && x.entry === k + 2), row.what);
    assert.ok(row.what.includes(`added entry ${k + 2} of 3 at this close at ${price(e.price)}.`), row.what);
    assert.ok(row.what.includes('Average entry price changed to'), row.what);
    assert.equal(row.entries, k + 2);
    // The add columns saw the entry before this one, not this one: the close's own order had not filled when they were read.
    assert.ok(near(row.cells[2].b, trade.entries![k].price * 1.03, 1e-9));
  });
});

test('an add order from the last bar is pending, and a strategy with no add rule says nothing of adds', () => {
  const A = bars([10, 10, 12, 15]);
  const bt = run('universe: A\ncapital: 1000\nentries: 3\nbuy when close > 9\nadd when close > last entry price * 1.01', { A });
  assert.equal(bt.run.states[0].pending, 'add');
  const rows = rowsOf(bt);
  const average = bt.run.trades[0].why!.adds![0].average;
  assert.equal(rows[3].what, `Added entry 2 of 3 at the open at 12.00. Average entry price changed to ${price(average)}. Buy rule held, but a long position was open. An order to add waits for the next open.`);
  assert.deepEqual(kinds(rows[3]), ['add', 'long', 'pending']);
  assert.equal(rows[3].entries, 2);
  // Without an add rule the table is as it was: no add columns, no new words.
  const plain = run('universe: A\ncapital: 1000\nbuy when close > 9', { A });
  assert.deepEqual(heads(plain), ['buy:close > 9']);
  assert.ok(rowsOf(plain).every((r) => r.entriesAllowed === 1 && !r.what.includes('ntr') && !positionWords(r).includes('entries')));
});

test('an add that was not made says why it may not have been: no cash, a position as large as its weight allows, or its commission', () => {
  const rule = 'entries: 3\nbuy when close > 99 and close < 150\nadd when close > 250\nsell when close < 1';
  // At half weight the position is worth all of its weight once the price is six times the first entry's, and nothing is left to add.
  const jump = bars([100, 100, 100, 100, 700, 700, 700, 700]);
  const nothing = run(`universe: A 50%\ncapital: 1000\n${rule}`, { A: jump });
  assert.deepEqual(nothing.run.trades.map((t) => t.entries!.length), [1]);
  const rows = rowsOf(nothing);
  const undone = rows.filter((r) => kinds(r).includes('add-undone'));
  assert.deepEqual(undone.map((r) => r.index), [4, 5, 6, 7]);
  assert.equal(undone[0].what, 'Add rule held, but no entry was made: there was no free cash, or the position was at the limit of its weight.');
  const addC = colOf(nothing, 'close > 250');
  assert.ok(rows.slice(4, 8).every((r) => r.cells[addC].outcome === 'yes' && r.entries === 1));
  // At the last bar the position has no room left at that close, so no add is left pending for the next open either.
  assert.equal(nothing.run.states[0].pending, null);
  assert.equal(rows[7].what, undone[0].what);

  // A commission that makes the add too small to be worth it, in a run that left such a trade undone, is named too.
  const dear = run(`universe: A\ncapital: 1000\ncommission: 60\n${rule}`, { A: bars([100, 100, 100, 100, 300, 300, 300, 300]) });
  assert.ok(dear.run.smallTrades! >= 1);
  assert.equal(dear.run.trades[0].entries!.length, 1);
  const named = rowsOf(dear).filter((r) => kinds(r).includes('add-undone'));
  assert.ok(named.length >= 2);
  assert.equal(named[0].what, 'Add rule held, but no entry was made: there was no free cash, or the position was at the limit of its weight, or its commission is 10% or more of it.');
  // A commission that held nothing back leaves the shorter words.
  const light = run(`universe: A 50%\ncapital: 1000\ncommission: 0.01\n${rule}`, { A: jump });
  assert.equal(light.run.smallTrades, 0);
  assert.equal(rowsOf(light).find((r) => kinds(r).includes('add-undone'))!.what, undone[0].what);
});

test('the file has the add columns and the entries made, one record for each bar', () => {
  const bt = run(THREE, { A: bars(CLOSES) });
  const lines = debugCsv(bt, 'A').trimEnd().split('\n');
  assert.equal(lines.length, CLOSES.length + 1);
  const head = lines[0].split(',');
  assert.ok(head.includes('add: close > last entry price * 1.03 (left)'), lines[0]);
  assert.deepEqual(head.slice(-4), ['position', 'shares', 'entries', 'what happened']);
  const cols = lines[9].split(',');
  assert.equal(cols[head.indexOf('entries')], '2');
  // Without entries the file is as it was.
  const plain = run('universe: A\ncapital: 1000\nbuy when close > 9', { A: bars([10, 11, 12]) });
  assert.deepEqual(debugCsv(plain, 'A').split('\n')[0].split(',').slice(-3), ['position', 'shares', 'what happened']);
});

// ---------------------------------------------------------------- the new functions

test('parts that use the newer functions get columns and values, and the table agrees with the indicators', () => {
  const rng = makeRng(21);
  const walk = (vol: number): Bars => {
    let c = 100;
    return bars(Array.from({ length: 300 }, () => (c *= 1 + (rng.next() - 0.48) * vol)));
  };
  const A = walk(0.04);
  const B = walk(0.03);
  const src = [
    'universe: A',
    'capital: 10000',
    'buy when bars_since(rsi(5) > 70) < 4 and supertrend_up(10, 3) and correl(close of B, 20) > 0.2 and zscore(20) > -1 and median(5) > wma(10)',
    'sell when hma(9) < wma(9) or cci(14) < -100',
  ].join('\n');
  const bt = run(src, { A, B });
  // A column for each part, in the order of the trade's explanation, with the user's own text, and the whole rule last.
  assert.deepEqual(
    heads(bt).filter((h) => h.startsWith('buy:')),
    [
      'buy:bars_since(rsi(5) > 70) < 4',
      'buy:bars_since(rsi(5) > 70)',
      'buy:rsi(5) > 70',
      'buy:supertrend_up(10, 3)',
      'buy:correl(close of B, 20) > 0.2',
      'buy:zscore(20) > -1',
      'buy:median(5) > wma(10)',
      `buy:${'bars_since(rsi(5) > 70) < 4 and supertrend_up(10, 3) and correl(close of B, 20) > 0.2 and zscore(20) > -1 and median(5) > wma(10)'}`,
    ].filter((h) => heads(bt).includes(h)),
  );
  const [bsC, upC, corC, zC, medC] = ['bars_since(rsi(5) > 70) < 4', 'supertrend_up(10, 3)', 'correl(close of B, 20) > 0.2', 'zscore(20) > -1', 'median(5) > wma(10)'].map((t) => colOf(bt, t));
  const rows = rowsOf(bt);
  const { c, h, l } = A;
  const since = ind.barsSince(ind.rsi(c, 5).map((v) => (Number.isNaN(v) ? NaN : v > 70 ? 1 : 0)));
  const up = ind.supertrend(h, l, c, 10, 3).up;
  const corr = ind.correl(c, B.c, 20);
  const z = ind.zscore(c, 20);
  const med = ind.median(c, 5);
  const wm = ind.wma(c, 10);
  const same = (a: number, b: number) => (Number.isNaN(a) ? Number.isNaN(b) : near(a, b, 1e-9));
  let known = 0;
  for (const r of rows) {
    assert.ok(same(r.cells[bsC].a, since[r.bar]), `bars_since at ${r.index}`);
    assert.ok(same(r.cells[corC].a, corr[r.bar]), `correl at ${r.index}`);
    assert.ok(same(r.cells[zC].a, z[r.bar]), `zscore at ${r.index}`);
    assert.ok(same(r.cells[medC].a, med[r.bar]) && same(r.cells[medC].b, wm[r.bar]), `median and wma at ${r.index}`);
    assert.equal(r.cells[upC].outcome, Number.isNaN(up[r.bar]) ? 'unknown' : up[r.bar] === 1 ? 'yes' : 'no', `supertrend_up at ${r.index}`);
    if (!Number.isNaN(corr[r.bar]) && !Number.isNaN(since[r.bar]) && !Number.isNaN(up[r.bar])) known++;
  }
  assert.ok(known > 100, `${known} bars with every part known`);
  assert.ok(rows.some((r) => r.cells[bsC].outcome === 'yes') && rows.some((r) => r.cells[bsC].outcome === 'no'));
  assert.ok(rows.some((r) => r.cells[corC].outcome === 'yes') && rows.some((r) => r.cells[corC].outcome === 'no'));
  // A part that is its warm-up is not complete says so, and the sell rule's newer functions are columns too.
  assert.equal(rows[0].cells[corC].outcome, 'unknown');
  assert.equal(rows[0].cells[corC].note, 'its warm-up is not complete');
  assert.deepEqual(heads(bt).filter((h) => h.startsWith('sell:')), ['sell:hma(9) < wma(9)', 'sell:cci(14) < -100', 'sell:hma(9) < wma(9) or cci(14) < -100']);
});
