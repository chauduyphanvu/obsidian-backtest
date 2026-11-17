import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec, type Param } from '../src/dsl.ts';
import { createRequester, differenceText, formatParam, sliderScale, sliderValues, type RequesterHandlers } from '../src/render-params.ts';
import type { RunOutput } from '../src/runner.ts';

/** The parameter a line declares, as the parser reads it. */
function param(line: string): Param {
  const { spec, errors } = parseSpec(`universe: SPY\n${line}\nbuy when rsi(2) < 30`);
  assert.deepEqual(errors, [], line);
  return spec!.params[0];
}

test('a declared range is the slider, in the units the block is written in', () => {
  assert.deepEqual(sliderScale(param('fast = 50 in 20..100 step 10')), { lo: 20, hi: 100, step: 10 });
  assert.deepEqual(sliderScale(param('stop = 8% in 4%..12% step 2%')), { lo: 4, hi: 12, step: 2 });
  assert.deepEqual(sliderScale(param('stop = 5% in 1%..10%')), { lo: 1, hi: 10, step: 1 });
  assert.deepEqual(sliderScale(param('x = 2.5 in 1..5 step 0.5')), { lo: 1, hi: 5, step: 0.5 });
});

test('a declared value off the step still sits on the slider', () => {
  assert.deepEqual(sliderScale(param('fast = 55 in 20..100 step 10')), { lo: 25, hi: 100, step: 10 });
  assert.deepEqual(sliderValues(param('fast = 55 in 20..100 step 10')), [25, 35, 45, 55, 65, 75, 85, 95]);
  assert.deepEqual(sliderScale(param('stop = 7% in 4%..12% step 2%')), { lo: 5, hi: 12, step: 2 });
});

test('a value with no range gets one from about half to double', () => {
  assert.deepEqual(sliderScale(param('fast = 50')), { lo: 25, hi: 100, step: 1 });
  assert.deepEqual(sliderScale(param('n = 10')), { lo: 5, hi: 20, step: 1 });
  assert.deepEqual(sliderScale(param('n = 3')), { lo: 2, hi: 7, step: 1 });
  assert.deepEqual(sliderScale(param('n = 1')), { lo: 1, hi: 5, step: 1 });
  assert.deepEqual(sliderScale(param('stop = 8%')), { lo: 4, hi: 16, step: 1 });
  assert.deepEqual(sliderScale(param('stop = 2%')), { lo: 1, hi: 4, step: 0.1 });
  assert.deepEqual(sliderScale(param('stop = 6.5%')), { lo: 3.3, hi: 13, step: 0.1 });
  assert.deepEqual(sliderScale(param('mult = 2.5')), { lo: 1.3, hi: 5, step: 0.1 });
});

test('a long window steps in larger whole numbers so the slider stays usable', () => {
  assert.deepEqual(sliderScale(param('slow = 200')), { lo: 100, hi: 400, step: 5 });
  assert.deepEqual(sliderScale(param('slow = 1000')), { lo: 500, hi: 2000, step: 20 });
});

test('zero and negative values get a range too', () => {
  assert.deepEqual(sliderScale(param('x = 0')), { lo: 0, hi: 10, step: 1 });
  assert.deepEqual(sliderScale(param('x = -4')), { lo: -8, hi: -2, step: 1 });
  assert.deepEqual(sliderScale(param('x = -2%')), { lo: -4, hi: -1, step: 0.1 });
});

test('every value a derived slider offers is whole when the block value is, and never below 1', () => {
  for (const v of [1, 2, 3, 4, 5, 7, 9, 10, 14, 20, 21, 50, 63, 100, 126, 200, 250, 999, 1000, 5000, 9999, 10000]) {
    const values = sliderValues(param(`n = ${v}`));
    assert.ok(values.includes(v), `${v} is on its slider`);
    assert.ok(values.every((x) => Number.isInteger(x) && x >= 1 && x <= 10000), `${v}: ${values[0]}..${values[values.length - 1]}`);
    assert.ok(values.length <= 121, `${v} has ${values.length} positions`);
  }
});

test('every value a derived slider offers for a percentage stays above 0 and below 100%', () => {
  for (const v of [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 6.5, 7, 8, 10, 12.5, 15, 20, 33, 50, 75, 90, 98, 99]) {
    const p = param(`s = ${v}%`);
    const values = sliderValues(p);
    assert.ok(values.some((x) => Math.abs(x - p.declared) < 1e-12), `${v}% is on its slider`);
    assert.ok(values.every((x) => x > 0 && x <= 0.99), `${v}%: ${values[0]}..${values[values.length - 1]}`);
    assert.ok(values.length <= 101, `${v}% has ${values.length} positions`);
  }
});

test('every value a derived slider offers is one the parser accepts as a window length', () => {
  for (const v of [1, 2, 3, 7, 14, 20, 50, 200, 252, 10000]) {
    const p = param(`n = ${v}`);
    for (const x of sliderValues(p)) {
      const { errors } = parseSpec('universe: SPY\nn = 1\nbuy when close > sma(n) and rsi(n) < 50 and atr(n) > 0\nsell when close < ema(n)', { overrides: { n: x } });
      assert.deepEqual(errors, [], `n = ${x} (from ${v})`);
    }
  }
});

test('every value a derived slider offers is one the parser accepts as a stop distance', () => {
  for (const v of [0.5, 1, 2, 5, 8, 10, 20, 50, 90]) {
    const p = param(`stop = ${v}%`);
    for (const x of sliderValues(p)) {
      for (const settings of ['stop loss: stop\ntrailing stop: stop\ntake profit: stop', 'risk per trade: stop at 2 atr(14)']) {
        const { errors } = parseSpec(`universe: SPY\nstop = 1%\nbuy when close > sma(20)\n${settings}`, { overrides: { stop: x } });
        assert.deepEqual(errors, [], `stop = ${x} (from ${v}%) in "${settings}"`);
      }
    }
  }
});

test('a value is written in the language\'s own form, with no floating-point tail', () => {
  assert.equal(formatParam({ percent: false }, 50), '50');
  assert.equal(formatParam({ percent: false }, 2.5), '2.5');
  assert.equal(formatParam({ percent: false }, 0.1 + 0.2), '0.3');
  assert.equal(formatParam({ percent: true }, 0.08), '8%');
  assert.equal(formatParam({ percent: true }, 0.065), '6.5%');
  assert.equal(formatParam({ percent: true }, 0.07), '7%');
});

test('the line under the bar names only the values that differ, and what the block says', () => {
  const params = [param('fast = 50'), { ...param('stop = 8%'), name: 'stop' }];
  assert.equal(differenceText(params, { fast: 50, stop: 0.08 }), null);
  assert.equal(differenceText(params, { fast: 80, stop: 0.08 }), 'Showing fast 80. The block says fast 50.');
  assert.equal(differenceText(params, { fast: 80, stop: 0.065 }), 'Showing fast 80, stop 6.5%. The block says fast 50, stop 8%.');
  assert.equal(differenceText(params, { fast: 50, stop: 0.06 }), 'Showing stop 6%. The block says stop 8%.');
});

// ---- asking for a run while a slider moves

type Answer = { out: RunOutput | null } | { error: unknown };
const tag = (name: string) => ({ name }) as unknown as RunOutput;

/** A hook whose answers are given by hand, and a log of what the bar was told. */
function requesting() {
  const asked: { values: Record<string, number>; settled: boolean; answer: (a: Answer) => void }[] = [];
  const log: string[] = [];
  const handlers: RequesterHandlers = {
    shown: (out, values, settled) => log.push(`shown ${(out as unknown as { name: string }).name} ${JSON.stringify(values)} ${settled}`),
    waiting: () => log.push('waiting'),
    loading: () => log.push('loading'),
    failed: (e, settled) => log.push(`failed ${e instanceof Error ? e.message : e} ${settled}`),
  };
  const requester = createRequester(
    {
      rerun: (values, settled) =>
        new Promise((resolve, reject) => {
          asked.push({ values, settled, answer: (a) => ('error' in a ? reject(a.error) : resolve(a.out)) });
        }),
    },
    handlers,
  );
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { asked, log, requester, flush };
}

test('a drag asks with settled false and a release with settled true, and each gets its own copy of the values', async () => {
  const { asked, requester, flush } = requesting();
  const values = { n: 250 };
  requester.request(values, false);
  values.n = 300;
  requester.request(values, true);
  // The release waits for the run that is out.
  assert.deepEqual(asked.map((a) => [a.values.n, a.settled]), [[250, false]]);
  asked[0].answer({ out: tag('a') });
  await flush();
  assert.deepEqual(asked.map((a) => [a.values.n, a.settled]), [[250, false], [300, true]]);
});

test('one run is out at a time: requests made meanwhile are replaced by the latest, which is asked for when the run comes back', async () => {
  const { asked, log, requester, flush } = requesting();
  requester.request({ n: 1 }, false);
  for (let n = 2; n <= 9; n++) requester.request({ n }, false);
  assert.equal(asked.length, 1);
  asked[0].answer({ out: tag('first') });
  await flush();
  assert.deepEqual(asked.map((a) => a.values.n), [1, 9]);
  asked[1].answer({ out: tag('latest') });
  await flush();
  assert.equal(asked.length, 2);
  // The first answer came after the drag had moved on: it is shown while the drag goes on, then the latest.
  assert.deepEqual(log, ['shown first {"n":1} false', 'shown latest {"n":9} false']);
});

test('a drag answer that comes after the release is not shown: only the release is', async () => {
  const { asked, log, requester, flush } = requesting();
  requester.request({ n: 1 }, false);
  requester.request({ n: 2 }, false);
  requester.request({ n: 2 }, true);
  asked[0].answer({ out: tag('drag') });
  await flush();
  assert.deepEqual(asked.map((a) => [a.values.n, a.settled]), [[1, false], [2, true]]);
  asked[1].answer({ out: tag('release') });
  await flush();
  assert.deepEqual(log, ['shown release {"n":2} true']);
});

test('an overtaken drag run that fails or needs more history says nothing', async () => {
  const { asked, log, requester, flush } = requesting();
  requester.request({ n: 1 }, false);
  requester.request({ n: 2 }, false);
  asked[0].answer({ error: new Error('older failed') });
  await flush();
  requester.request({ n: 3 }, false);
  asked[1].answer({ out: null });
  await flush();
  asked[2].answer({ out: tag('c') });
  await flush();
  assert.deepEqual(log, ['shown c {"n":3} false']);
});

test('an answer is shown with the values it was asked for', async () => {
  const { asked, log, requester, flush } = requesting();
  requester.request({ n: 250 }, false);
  asked[0].answer({ out: tag('a') });
  await flush();
  assert.deepEqual(log, ['shown a {"n":250} false']);
});

test('a value that needs more history during a drag is not fetched: the bar is told to wait and nothing is redrawn', async () => {
  const { asked, log, requester, flush } = requesting();
  requester.request({ n: 250 }, false);
  asked[0].answer({ out: tag('a') });
  await flush();
  requester.request({ n: 400 }, false);
  asked[1].answer({ out: null });
  await flush();
  assert.deepEqual(log, ['shown a {"n":250} false', 'waiting']);
});

test('on release the bar says it is loading, then shows the answer', async () => {
  const { asked, log, requester, flush } = requesting();
  requester.request({ n: 400 }, false);
  asked[0].answer({ out: null });
  await flush();
  requester.request({ n: 400 }, true);
  assert.equal(asked[1].settled, true);
  asked[1].answer({ out: tag('b') });
  await flush();
  assert.deepEqual(log, ['waiting', 'loading', 'shown b {"n":400} true']);
});

test('a release that was not preceded by a wait does not say it is loading', async () => {
  const { asked, log, requester, flush } = requesting();
  requester.request({ n: 200 }, true);
  asked[0].answer({ out: tag('a') });
  await flush();
  assert.deepEqual(log, ['shown a {"n":200} true']);
});

test('only the latest request is used: an older answer that arrives later is dropped, whether it succeeds or fails', async () => {
  const { asked, log, requester, flush } = requesting();
  requester.request({ n: 300 }, true);
  requester.request({ n: 350 }, true);
  asked[0].answer({ out: tag('older') });
  await flush();
  asked[1].answer({ out: tag('latest') });
  await flush();
  assert.deepEqual(log, ['shown latest {"n":350} true']);

  const second = requesting();
  second.requester.request({ n: 300 }, true);
  second.requester.request({ n: 350 }, true);
  second.asked[0].answer({ error: new Error('older failed') });
  await second.flush();
  second.asked[1].answer({ out: tag('latest') });
  await second.flush();
  assert.deepEqual(second.log, ['shown latest {"n":350} true']);
});

test('a failure of the latest request is reported with whether it was a release', async () => {
  const { asked, log, requester, flush } = requesting();
  requester.request({ n: 400 }, true);
  asked[0].answer({ error: new Error('No file at Data/x.csv') });
  await flush();
  requester.request({ n: 500 }, false);
  asked[1].answer({ error: 'plain text' });
  await flush();
  assert.deepEqual(log, ['failed No file at Data/x.csv true', 'failed plain text false']);
});

test('a drag frame after a wait that finds values it can show clears the wait by showing them', async () => {
  const { asked, log, requester, flush } = requesting();
  requester.request({ n: 400 }, false);
  asked[0].answer({ out: null });
  await flush();
  requester.request({ n: 220 }, false);
  asked[1].answer({ out: tag('c') });
  await flush();
  requester.request({ n: 230 }, true);
  assert.deepEqual(log, ['waiting', 'shown c {"n":220} false']);
});

test('after cancel nothing is reported', async () => {
  const { asked, log, requester, flush } = requesting();
  requester.request({ n: 300 }, true);
  requester.cancel();
  asked[0].answer({ out: tag('a') });
  await flush();
  assert.deepEqual(log, []);
});

test('a failing hook never leaves an unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const on = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', on);
  const { asked, requester, flush } = requesting();
  requester.request({ n: 1 }, true);
  requester.request({ n: 2 }, true);
  asked[0].answer({ error: new Error('stale') });
  await flush();
  asked[1].answer({ error: new Error('latest') });
  await flush();
  await flush();
  process.off('unhandledRejection', on);
  assert.deepEqual(unhandled, []);
});
