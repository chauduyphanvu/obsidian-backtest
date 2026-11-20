// The hashes that users' vaults keep: each try counted for "Was it luck?" is saved by trialHash, each version by
// versionHash. These values were taken from 0.12.0. A change to the parsed spec or to the default settings that moves them
// counts every try again in every vault, so a failure here asks for a migration, not new values.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec } from '../src/dsl.ts';
import { defaultsHash, trialHash, versionHash } from '../src/ledger.ts';
import { DEFAULT_SETTINGS, defaultsFrom } from '../src/settings-core.ts';

const defaults = defaultsFrom(DEFAULT_SETTINGS);

const SAVED: [name: string, source: string, trial: string, version: string][] = [
  ['an average', 'universe: SPY\nbuy when close > sma(200)\nsell when close < sma(200)', '6n5yut7wkf', '1my62bs2zmz'],
  [
    'costs and stops',
    'universe: SPY\ncosts: 5 bps\nslippage: 2 bps\ncommission: 1\nstop loss: 8%\ntake profit: 20%\ntrailing stop: 2 atr(14)\nbuy when close > sma(50)\nsell when close < sma(50)',
    '24xcc3esyz4',
    'v7kah4db30',
  ],
  ['a parameter range', 'universe: SPY\nfrom: 2015-01-01\nn = 50 in 20..100 step 10\nbuy when close > sma(n)\nsell when close < sma(n)', 'jvc8muln7z', '1zzby3ak7lg'],
  [
    'a short side',
    'universe: SPY\nbuy when close > sma(200)\nsell when close < sma(200)\nshort when close < sma(200)\ncover when close > sma(200)',
    '2bd02smnuvk',
    '2e7x1wdg26j',
  ],
  ['a ranking', 'universe: SPY, QQQ, IWM\nhold: top 2 by roc(126)\nrebalance: monthly\nbuy when close > sma(100)\nsell when close < sma(100)', '1yvqyitqlza', 'rvmlbhodsl'],
  ['a definition', 'universe: SPY\nuptrend = close > sma(200)\nbuy when uptrend and rsi(2) < 10\nsell when not uptrend or rsi(2) > 70', '1rlcwyrb74t', 'pjog575q3e'],
  ['entries', 'universe: SPY\nentries: 3\nbuy when close > sma(200)\nadd when close > last entry price * 1.03\nsell when close < sma(200)', '78eunpbizg', '1vn4z4osde6'],
  [
    'fill at the close and magnify',
    'universe: binance:BTCUSDT\ninterval: 1d\nfill: close\nmagnify: 1h\nstop loss: 5%\nbuy when close > ema(50)\nsell when close < ema(50)',
    '2awzpjreg7p',
    '234o9e72yu4',
  ],
];

const WHY = 'Users keep this hash in their vaults. A new value counts their tries again, so keep the old value or migrate the saved records.';

test('the saved hash of each try and each version stays as 0.12.0 made it', () => {
  for (const [name, source, trial, version] of SAVED) {
    const { spec, errors } = parseSpec(source, { defaults });
    assert.deepEqual(errors, [], name);
    assert.equal(trialHash(spec!), trial, `${name}, trialHash. ${WHY}`);
    assert.equal(versionHash(source, defaults), version, `${name}, versionHash. ${WHY}`);
  }
});

test('the saved hash of the default settings stays as 0.12.0 made it', () => {
  assert.equal(defaultsHash(defaults), 'kif09l3rta', WHY);
});
