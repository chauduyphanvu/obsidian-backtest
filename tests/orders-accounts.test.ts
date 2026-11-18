import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { parseSpec } from '../src/dsl.ts';
import { accountOrderBadge, accountOrderText, ordersMarkdown, scanAccounts, sortAccounts, type AccountScanHost, type AccountStatus } from '../src/orders.ts';
import type { AccountOrder } from '../src/account.ts';
import type { RunOutput } from '../src/runner.ts';
import { bars } from './helpers.ts';

const fence = '```';
const NOTES: Record<string, string> = {
  Trend: `${fence}strategy\nname: Trend\nuniverse: A\ncapital: 1000\nbuy when close > 11\nsell when close < 9\n${fence}`,
  Hold: `${fence}strategy\nuniverse: B\ncapital: 1000\nbuy when true\n${fence}`,
};
const DATA = new Map([
  ['A', bars([10, 11, 12])],
  ['B', bars([20, 20, 20])],
]);

function host(blocks: { note: string; name: string; source: string }[]): AccountScanHost & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    find: async () => blocks,
    strategies: () => ({
      note: (link) => (link in NOTES ? { basename: link, text: NOTES[link] } : null),
      read: async (f) => (f as unknown as { text: string }).text,
      run: async (source): Promise<RunOutput> => {
        ran.push(source);
        const spec = parseSpec(source).spec!;
        return { spec, backtest: runBacktest(spec, DATA), data: DATA, warnings: [], prices: [] };
      },
    }),
  };
}

test("each account's orders are its strategies' orders netted at its size, in shares", async () => {
  // Trend buys A at the next open, all of its equity; Hold holds B. Half each of 2,000 in cash.
  const h = host([{ note: 'Accounts/Main.md', name: 'Main', source: 'cash: 2,000\n[[Trend]] 50%\n[[Hold]] 50%' }]);
  const [main] = await scanAccounts(h);
  assert.equal(main.error, null);
  assert.deepEqual(main.orders.map((o) => [o.ticker, o.shares]), [['A', 83], ['B', 50]]);
  assert.equal(main.asOf, DATA.get('A')!.t[2]);
  assert.equal(h.ran.length, 2);
});

test('an account that holds what its strategies hold has nothing to trade, and one that cannot run says why', async () => {
  const [done, wrong, missing] = await scanAccounts(
    host([
      { note: 'Done.md', name: 'Done', source: 'holdings: B 50\n[[Hold]]' },
      { note: 'Wrong.md', name: 'Wrong', source: 'cash: lots\n[[Hold]]' },
      { note: 'Missing.md', name: 'Missing', source: 'cash: 10\n[[Nowhere]]' },
    ]),
  );
  assert.deepEqual([done.orders, done.error], [[], null]);
  assert.match(wrong.error!, /^Line 1: "lots" is not an amount of cash/);
  assert.equal(missing.error, 'Line 2: there is no note called "Nowhere".');
  assert.equal(missing.asOf, null);
});

test('an order in words, and accounts by name', () => {
  assert.equal(accountOrderText({ shares: 12, kind: 'open', holding: 0 }), 'Buy 12 shares');
  assert.equal(accountOrderText({ shares: -1, kind: 'resize', holding: 3 }), 'Sell 1 share');
  assert.equal(accountOrderText({ shares: -0.5, kind: 'close', holding: 0.5 }), 'Sell all 0.5 shares');
  const a = (name: string): AccountStatus => ({ note: `${name}.md`, name, orders: [], asOf: null, error: null });
  assert.deepEqual(sortAccounts([a('b 10'), a('B 9'), a('a')]).map((x) => x.name), ['a', 'B 9', 'b 10']);
});

test("the saved note lists each account's orders in a table, and the others in a line each", async () => {
  const accounts = await scanAccounts(
    host([
      { note: 'Accounts/Main.md', name: 'Main', source: 'cash: 2,000\n[[Trend]] 50%\n[[Hold]] 50%' },
      { note: 'Done.md', name: 'Done', source: 'holdings: B 50\n[[Hold]]' },
      { note: 'Wrong.md', name: 'Wrong', source: 'cash: 10\n[[Nowhere]]' },
    ]),
  );
  const md = ordersMarkdown([], Date.UTC(2026, 10, 17), accounts);
  // With no strategy found, the note says only that.
  assert.ok(!md.includes('## Accounts'));
  const status = { note: 'Trend.md', strategy: 'Trend', asOf: DATA.get('A')!.t[2], interval: '1d', orders: [], holdings: [], equity: 1000, warnings: [], error: null, closeFill: false, stale: false };
  const full = ordersMarkdown([status], Date.UTC(2026, 10, 17), accounts);
  const section = full.slice(full.indexOf('## Accounts'), full.indexOf('## Nothing to do'));
  assert.equal(
    section,
    [
      '## Accounts',
      '',
      "What each account block trades at the next open, in shares: its strategies' orders netted together at the account's size, with each holding brought to their positions. The block shows where each order comes from.",
      '',
      '| Account | Order | Ticker | Last close |',
      '| --- | --- | --- | ---: |',
      '| [[Accounts/Main\\|Main]] | Buy 83 shares | A | 12.00 |',
      '| [[Accounts/Main\\|Main]] | Buy 50 shares | B | 20.00 |',
      '',
      '- [[Done|Done]]: nothing to trade',
      `- [[Wrong|Wrong]]: couldn't be worked out. Line 2: there is no note called "Nowhere".`,
      '',
      '',
    ].join('\n'),
  );
  // Without accounts the note has no such section.
  assert.ok(!ordersMarkdown([status], Date.UTC(2026, 10, 17)).includes('## Accounts'));
});

test('an account order in the orders window: its badge, and the words after it', () => {
  const badge = (shares: number, kind: AccountOrder['kind'], holding: number) => accountOrderBadge({ shares, kind, holding });
  assert.deepEqual(badge(12, 'open', 0), { action: 'Buy', style: 'buy', text: '12 shares' });
  assert.deepEqual(badge(-30, 'close', 30), { action: 'Sell', style: 'sell', text: 'all 30 shares' });
  assert.deepEqual(badge(-5, 'open', 0), { action: 'Sell short', style: 'short', text: '5 shares' });
  assert.deepEqual(badge(10, 'close', -10), { action: 'Buy to cover', style: 'cover', text: 'all 10 shares' });
  assert.deepEqual(badge(-80, 'flip', 30), { action: 'Flip', style: 'sell', text: 'sell 30 shares, then sell short 50 shares' });
  assert.deepEqual(badge(80, 'flip', -20), { action: 'Flip', style: 'buy', text: 'buy to cover 20 shares, then buy 60 shares' });
});
