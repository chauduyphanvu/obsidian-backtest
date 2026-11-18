// Running Rearview's command-line tool and reading what it writes. Money and prices come in
// millionths of a dollar, quantities in millionths of a share (the run asks for 6 share decimals).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const M = 1_000_000;

export function rvw(bin: string, args: string[]): string {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(`rvw ${args[0]} failed: ${err.stderr || err.stdout || err.message}`);
  }
}

function table(path: string): Record<string, string>[] {
  const [head, ...lines] = readFileSync(path, 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.filter((l) => l).map((l) => {
    const f = l.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, f[i] ?? '']));
  });
}

export interface RvTrade {
  id: number;
  dir: 'LONG' | 'SHORT';
  entryDate: string;
  exitDate: string | null;
  /** The average of the trade's entry fills: its buys, or for a short its short sales. */
  entryPx: number;
  exitPx: number | null;
  qty: number;
  pnl: number;
  borrowFees: number;
  reason: string;
  barsHeld: number;
}

export interface RvFill {
  seq: number;
  date: string;
  id: number;
  /** BUY and SELL for a long, SHORT and COVER for a short. */
  side: string;
  qty: number;
  price: number;
  commission: number;
  reason: string;
}

export interface RvRun {
  /** Cash leaves out the proceeds of short sales, which Rearview holds apart at what they brought in. */
  daily: { date: string; cash: number; shortProceeds: number; longMv: number; shortMv: number; equity: number }[];
  trades: RvTrade[];
  fills: RvFill[];
  interest: number;
  marginInterest: number;
  borrowFees: number;
  warnings: { code: string; message: string }[];
  summary: Record<string, number>;
  orders: { id: number; side: string; kind: string; status: string }[];
}

export function readRun(dir: string): RvRun {
  const daily = table(join(dir, 'daily.csv')).map((r) => ({
    date: r.date,
    cash: Number(r.cash) / M,
    shortProceeds: Number(r.short_proceeds) / M,
    longMv: Number(r.long_mv) / M,
    shortMv: Number(r.short_mv) / M,
    equity: Number(r.equity) / M,
  }));
  const trades = table(join(dir, 'trades.csv')).map((r) => ({
    id: Number(r.id),
    dir: r.dir as RvTrade['dir'],
    entryDate: r.entry_date,
    exitDate: r.exit_date || null,
    entryPx: Number(r.entry_px) / M,
    exitPx: r.exit_px ? Number(r.exit_px) / M : null,
    qty: Number(r.qty) / M,
    pnl: Number(r.pnl) / M,
    borrowFees: Number(r.borrow_fees) / M,
    reason: r.exit_reason,
    barsHeld: Number(r.bars_held),
  }));
  const fills = table(join(dir, 'fills.csv')).map((r) => ({
    seq: Number(r.seq),
    date: r.date,
    id: Number(r.id),
    side: r.side,
    qty: Number(r.qty) / M,
    price: Number(r.price) / M,
    commission: Number(r.commission) / M,
    reason: r.reason,
  }));
  const events = table(join(dir, 'events.csv'));
  // Charges are negative amounts; each total is returned as what was earned or paid.
  const total = (kind: string) => Math.abs(events.filter((r) => r.kind === kind).reduce((s, r) => s + Number(r.amount) / M, 0));
  const warnings = JSON.parse(readFileSync(join(dir, 'warnings.json'), 'utf8')) as { code: string; message: string }[];
  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as Record<string, number>;
  const orders = table(join(dir, 'orders.csv')).map((r) => ({ id: Number(r.id), side: r.side, kind: r.kind, status: r.status }));
  return { daily, trades, fills, interest: total('CASH_INTEREST'), marginInterest: total('MARGIN_INTEREST'), borrowFees: total('BORROW_FEE'), warnings, summary, orders };
}

/** `rvw eval` values: ticker -> name -> date -> value (NaN where Rearview leaves it empty). */
export function readEval(path: string): Map<string, Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, Map<string, number>>>();
  for (const r of table(path)) {
    let byName = out.get(r.ticker);
    if (!byName) out.set(r.ticker, (byName = new Map()));
    for (const [k, v] of Object.entries(r)) {
      if (k === 'date' || k === 'ticker') continue;
      let byDate = byName.get(k);
      if (!byDate) byName.set(k, (byDate = new Map()));
      byDate.set(r.date, v === '' ? NaN : Number(v));
    }
  }
  return out;
}
