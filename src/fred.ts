// FRED's economic series as rows a rule can read. Each value is dated the day it was first published, from ALFRED's
// first-release view, so a rule never reads a value before anyone could have known it.

import { DAY } from './format.ts';
import { emptyBars, type Bars } from './types.ts';

/** A series' first day of publication with more observations than this is a backfill: history put in at once. */
export const BACKFILL = 5;

/**
 * The earliest real-time day a request asks for, so ALFRED gives each observation's first release. A row that gives this
 * day back as its publication carries no date of its own.
 */
export const REALTIME_START = '1776-07-04';

interface Observation {
  /** The day the observation is for: a day, or the first day of its week's end, month, quarter or year as FRED dates it. */
  date: number;
  /** The day it was first published, or NaN when FRED gave no date that can be read. */
  published: number;
  value: number;
}

export interface FredSeries {
  bars: Bars;
  /** What the result says about values dated by the usual delay instead of their first publication; null when there are none. */
  note: string | null;
}

/** Midnight UTC of a `YYYY-MM-DD` day, or NaN. */
function dayOf(s: unknown): number {
  const m = typeof s === 'string' ? s.match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  if (!m) return NaN;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? t : NaN;
}

const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);

function addMonths(t: number, months: number): number {
  const d = new Date(t);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * How a series' observations are dated, from the usual gap between them. FRED dates a daily or weekly value by its last
 * day (a week by the day it ends), and a monthly, quarterly or yearly one by its first day.
 */
function periods(dates: number[]): { lastDay: (date: number) => number; nextLastDay: (date: number) => number; name: string } {
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) if (dates[i] > dates[i - 1]) gaps.push(dates[i] - dates[i - 1]);
  const gap = gaps.length ? median(gaps) : DAY;
  if (gap < 20 * DAY) {
    const days = Math.max(1, Math.round(gap / DAY));
    return { lastDay: (d) => d, nextLastDay: (d) => d + days * DAY, name: days === 1 ? 'a day' : days === 7 ? 'a week' : `${days} days` };
  }
  const months = Math.max(1, Math.round(gap / (30.4375 * DAY)));
  const name = months === 1 ? 'a month' : months === 3 ? 'a quarter' : months === 12 ? 'a year' : `${months} months`;
  return { lastDay: (d) => addMonths(d, months) - DAY, nextLastDay: (d) => addMonths(d, 2 * months) - DAY, name };
}

const days = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;

/** "2008-01-02", or "5 days from 2008-01-02 to 2010-05-01". */
function onDays(published: number[]): string {
  const known = [...new Set(published.filter((p) => Number.isFinite(p)))].sort((a, b) => a - b);
  if (known.length === 0) return 'on a day FRED does not give';
  if (known.length === 1) return `on ${iso(known[0])}`;
  return `on ${known.length} days from ${iso(known[0])} to ${iso(known[known.length - 1])}`;
}

/**
 * FRED's observations JSON, asked for with `output_type=4` (each observation once, as first released) and the earliest
 * `realtime_start`, to rows a rule reads: one on each day a newer observation was first published, holding the value of
 * the newest one known that day, so `t` grows with every row. A missing value ("."), and a row whose date cannot be read,
 * is left out. Values may be zero or below.
 *
 * ALFRED's first vintage of a series often holds its whole history, published on the day the series was added, as the
 * figures known that day. When more than BACKFILL observations were first published on the series' first day, they are
 * taken for such a backfill, and each of them is dated instead the median delay after its period's last day that the
 * other observations show, or a whole period later when none shows it; never later than its own publication, when that
 * came after its period. Its value stays the one of that first vintage. Many values first published on a later day are a
 * real publication, such as a week's values put out at once, and are dated by it.
 */
export function parseFred(json: string, id: string): FredSeries {
  const body = JSON.parse(json) as { observations?: unknown };
  if (!Array.isArray(body?.observations)) throw new Error('FRED sent no observations');
  const first = new Map<number, Observation>();
  for (const row of body.observations as Record<string, unknown>[]) {
    const date = dayOf(row?.date);
    const raw = row?.value;
    const value = typeof raw === 'string' && raw.trim() !== '' && raw.trim() !== '.' ? Number(raw) : NaN;
    if (!Number.isFinite(date) || !Number.isFinite(value)) continue;
    const published = row?.realtime_start === REALTIME_START ? NaN : dayOf(row?.realtime_start);
    const seen = first.get(date);
    // An observation listed again, as a revision would be, keeps its first release.
    if (!seen || (Number.isFinite(published) && !(seen.published <= published))) first.set(date, { date, published, value });
  }
  const obs = [...first.values()].sort((a, b) => a.date - b.date);
  const period = periods(obs.map((o) => o.date));

  // Only the first day can be the backfill: a later day with many values is a real publication, such as a week's values
  // put out together, and is dated as such.
  const firstDay = obs.reduce((m, o) => (o.published < m ? o.published : m), Infinity);
  const backfillDay = obs.filter((o) => o.published === firstDay).length > BACKFILL ? firstDay : NaN;
  const backfilled = (o: Observation) => !Number.isFinite(o.published) || o.published === backfillDay;
  const delays = obs.filter((o) => !backfilled(o) && o.published >= period.lastDay(o.date)).map((o) => o.published - period.lastDay(o.date));
  const delay = delays.length ? Math.round(median(delays) / DAY) * DAY : null;

  const dated = obs.map((o) => {
    if (!backfilled(o)) return { t: o.published, o };
    const last = period.lastDay(o.date);
    const usual = delay === null ? period.nextLastDay(o.date) : last + delay;
    return { t: o.published >= last ? Math.min(usual, o.published) : usual, o };
  });
  dated.sort((a, b) => a.t - b.t || a.o.date - b.o.date);

  const bars = emptyBars();
  let newest = -Infinity;
  for (let i = 0; i < dated.length; i++) {
    // In this order the last observation known on a day is the newest of that day.
    if (i + 1 < dated.length && dated[i + 1].t === dated[i].t) continue;
    const { t, o } = dated[i];
    if (o.date <= newest) continue;
    newest = o.date;
    bars.t.push(t);
    for (const k of ['o', 'h', 'l', 'c'] as const) bars[k].push(o.value);
    bars.v.push(0);
  }

  const redated = obs.filter(backfilled);
  let note: string | null = null;
  if (redated.length) {
    const span = redated.length === 1 ? iso(redated[0].date) : `${iso(redated[0].date)} to ${iso(redated[redated.length - 1].date)}`;
    const how =
      delay === null
        ? `${period.name} after its period ends, as no value published later shows the usual delay`
        : delay === 0
          ? 'on the last day of its period, the usual delay of the values published later'
          : `${days(delay / DAY)} after the last day of its period, the median delay of the values published later`;
    note =
      `FRED first published ${redated.length} ${redated.length === 1 ? 'value' : 'values'} of ${id} (dated ${span}) together ${onDays(redated.map((o) => o.published))}, ` +
      `so each is dated ${how}, and never later than it was published. ` +
      `${redated.length === 1 ? 'It is' : 'They are'} the figures of that first release, which may already include later revisions: only the dates are estimates.`;
  }
  return { bars: { ...bars, values: true }, note };
}
