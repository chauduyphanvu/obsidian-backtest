import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DataDeps } from '../src/data.ts';
import { Runner } from '../src/runner.ts';
import { near } from './helpers.ts';

const csv = (closes: number[]) => ['date,open,high,low,close', ...closes.map((c, i) => `2020-01-0${i + 1},${c},${c},${c},${c}`)].join('\n');

function deps(files: Record<string, string>): DataDeps & { read: string[] } {
  const read: string[] = [];
  return {
    read,
    fetchText: () => Promise.reject(new Error('no network in tests')),
    readVaultFile: async (path) => {
      read.push(path);
      return files[path] ?? null;
    },
    cacheRead: async () => null,
    cacheWrite: async () => {},
    now: () => Date.UTC(2020, 1, 1),
  };
}

test('the runner parses with its defaults and loads the cash-rate ticker with the prices', async () => {
  const d = deps({ 'prices/a.csv': csv([10, 10, 10]), 'rates/bills.csv': csv([36.5, 36.5, 36.5]) });
  const runner = new Runner(d, { capital: 1000, cashRate: 'csv:rates/bills.csv' });
  const { spec, errors } = runner.parse('universe: csv:prices/a.csv\nlimit = 20\nbuy when close > limit', { limit: 11 });
  assert.deepEqual(errors, []);
  assert.deepEqual(spec!.cash, { k: 'ticker', ref: { name: 'bills', source: 'csv', id: 'rates/bills.csv' } });
  const out = await runner.run(spec!);
  assert.deepEqual(d.read.sort(), ['prices/a.csv', 'rates/bills.csv']);
  // Never invested: 1000 earns 36.5% a year for two one-day steps.
  assert.ok(near(out.backtest.run.equity[2], 1000 * 1.001 * 1.001));
  assert.ok(near(out.backtest.interest, 1000 * 1.001 * 1.001 - 1000));
  assert.equal(out.backtest.cashRateNote, 'Cash earns the bills rate');
});
