import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../src/backtest.ts';
import { compareCurves, parseCompare, type CompareHost } from '../src/compare.ts';
import { parseSpec } from '../src/dsl.ts';
import { scanOrders, type ScanHost } from '../src/orders.ts';
import type { RunOutput } from '../src/runner.ts';
import { bars } from './helpers.ts';

function run(src: string): RunOutput {
  const { spec } = parseSpec(src);
  const data = new Map([['A', bars([10, 11, 12, 11, 13, 14, 13, 15])]]);
  return { spec: spec!, backtest: runBacktest(spec!, data), data, warnings: [], prices: [] };
}

const FENCE = '```';
const GOOD = 'universe: A\nbuy when true';

test('a scan runs every strategy found, in the background, and says how far it got', async () => {
  const progress: string[] = [];
  const asked: { freshForMs?: number; background: boolean }[] = [];
  let cleared = 0;
  const host: ScanHost = {
    clear: () => void cleared++,
    find: async () => [
      { note: 'A.md', name: 'One', source: GOOD },
      { note: 'B.md', name: 'Two', source: 'broken' },
    ],
    run: async (source, opts) => {
      asked.push(opts);
      if (source === 'broken') throw new Error('It broke.');
      return run(source);
    },
  };
  const list = await scanOrders(host, false, (done, total) => void progress.push(`${done}/${total}`));
  assert.deepEqual(list.map((s) => [s.note, s.strategy, s.error]), [['A.md', 'One', null], ['B.md', 'Two', 'It broke.']]);
  assert.deepEqual(progress, ['0/2', '1/2', '2/2']);
  assert.equal(cleared, 0);
  assert.deepEqual(asked, [{ freshForMs: undefined, background: true }, { freshForMs: undefined, background: true }]);
});

test('a forced scan drops the kept results first and takes prices fetched since it began as fresh', async () => {
  let cleared = 0;
  const fresh: (number | undefined)[] = [];
  const host: ScanHost = {
    clear: () => void cleared++,
    find: async () => [{ note: 'A.md', name: 'One', source: GOOD }],
    run: async (source, opts) => {
      fresh.push(opts.freshForMs);
      return run(source);
    },
  };
  await scanOrders(host, true, () => {});
  assert.equal(cleared, 1);
  assert.equal(typeof fresh[0], 'number');
  assert.ok(fresh[0]! >= 0 && fresh[0]! < 1000);
});

interface Note {
  basename: string;
  text: string;
}

function notes(map: Record<string, string>, fails: string[] = []): { host: CompareHost<Note>; links: string[] } {
  const links: string[] = [];
  return {
    links,
    host: {
      note: (link) => {
        links.push(link);
        return link in map ? { basename: link.split('/').pop()!, text: map[link] } : null;
      },
      read: async (file) => file.text,
      run: async (source) => {
        if (fails.some((f) => source.includes(f))) throw new Error('No file at x.csv');
        return run(source);
      },
    },
  };
}

const block = (text: string) => `${FENCE}strategy\n${text}\n${FENCE}`;

test('each entry is the first strategy of its note, or the one it names, labelled as the block says', async () => {
  const { host, links } = notes({ Trend: `${block(`name: First\n${GOOD}`)}\n${block(`name: Second\n${GOOD}`)}`, 'Research/Other': block(GOOD) });
  const { entries } = parseCompare('[[Trend#second]] 50%\n[[Research/Other.md|Mine]] 50%\n');
  const curves = await compareCurves(entries, host);
  assert.deepEqual(curves.map((c) => c.label), ['Second', 'Mine']);
  assert.deepEqual(links, ['Trend', 'Research/Other']);
  assert.equal(curves[0].t.length, curves[0].equity.length);
  assert.equal(curves[0].cash?.[0], 1);
});

test('an entry that cannot be resolved or run stops the comparison with its line', async () => {
  const { host } = notes({ Empty: 'no blocks', Trend: block(`name: First\n${GOOD}`), Bad: block('name: Bad\nuniverse: csv:x.csv\nbuy when true') }, ['csv:x.csv']);
  const first = async (text: string) => compareCurves(parseCompare(text).entries, host);
  await assert.rejects(first('[[Trend]]\n[[Nowhere]]'), { message: 'Line 2: there is no note called "Nowhere".' });
  await assert.rejects(first('[[Trend]]\n[[Empty]]'), { message: 'Line 2: "Empty" has no strategy block.' });
  await assert.rejects(first('[[Trend#Other]]\n[[Trend]]'), { message: 'Line 1: "Trend" has no strategy named "Other".' });
  await assert.rejects(first('[[Trend]]\n[[Bad]]'), { message: 'Line 2: "Bad" couldn\'t run. No file at x.csv' });
});
