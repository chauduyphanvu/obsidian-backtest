// Words a parameter or definition can't take. Blocks written since 0.7.0 may use any other word as a name, so the list can
// only stay the same or get shorter: a word the language gains goes in LATER_WORDS, where an old block can still use it as
// a name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESERVED } from '../src/dsl.ts';

/** RESERVED at 0.12.0. */
const FROZEN = new Set([
  'above', 'abs', 'adx', 'all', 'always', 'and', 'at', 'atr', 'bars', 'bars_held', 'bars_since', 'bb_lower', 'bb_upper', 'below',
  'benchmark', 'buy', 'by', 'capital', 'cci', 'close', 'commission', 'correl', 'costs', 'crosses', 'data', 'day', 'ema', 'entries',
  'entries_made', 'entry', 'entry_price', 'false', 'fill', 'for', 'from', 'high', 'highest', 'hma', 'hold', 'in', 'interval', 'is',
  'keltner_lower', 'keltner_upper', 'last_entry_price', 'low', 'lowest', 'macd', 'macd_signal', 'magnify', 'max', 'median', 'mfi', 'min',
  'minus_di', 'month', 'month_end', 'month_start', 'name', 'never', 'not', 'obv', 'of', 'open', 'or', 'percent_rank', 'plus_di',
  'rebalance', 'roc', 'rsi', 'sell', 'size', 'slippage', 'slope', 'sma', 'stdev', 'step', 'stoch_d', 'stoch_k', 'supertrend',
  'supertrend_up', 'symbol', 'to', 'top', 'true', 'universe', 'volume', 'vwap', 'weekday', 'weighting', 'when', 'williams_r', 'wma',
  'year', 'zscore',
]);

test('no word joins the reserved words, so an old block that uses it as a name keeps working', () => {
  for (const word of RESERVED) {
    assert.ok(FROZEN.has(word), `"${word}" is a new reserved word. Put it in LATER_WORDS (src/dsl.ts), or old blocks that use it as a name stop running.`);
  }
});
