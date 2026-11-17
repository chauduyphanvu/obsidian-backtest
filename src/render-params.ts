import { h } from './dom.ts';
import type { Param } from './dsl.ts';
import { plainNumber } from './rewrite.ts';
import type { RunOutput } from './runner.ts';

/** Where a parameter's slider runs, in the units the block is written in: percentage points for a percentage. */
export interface SliderScale {
  lo: number;
  hi: number;
  step: number;
}

/** How a run is redone with other parameter values, and how those values are written into the block. */
export interface ParamsHook {
  /** Values are keyed by parameter name, as fractions for percentages. Rejects with a plain message when the block does not run with them. */
  rerun(values: Record<string, number>): Promise<RunOutput>;
  /** Present only where the block can be edited. */
  apply?: (values: Record<string, number>) => Promise<void>;
}

const clean = (x: number) => Number(x.toPrecision(12));
const shown = (p: Pick<Param, 'percent'>, value: number) => clean(p.percent ? value * 100 : value);
const stored = (p: Pick<Param, 'percent'>, x: number) => clean(p.percent ? x / 100 : x);

/** A value the way the block writes it: `50`, `8%`, `6.5%`. */
export function formatParam(p: Pick<Param, 'percent'>, value: number): string {
  return plainNumber(shown(p, value)) + (p.percent ? '%' : '');
}

/** The longest window a period can be. */
const MAX_PERIOD = 10_000;
/** Most positions a slider offers, so the step stays easy to hit and to walk with the arrow keys. */
const MAX_POSITIONS = { whole: 120, percent: 100, other: 60 };

function decimals(x: number): number {
  const text = String(clean(Math.abs(x)));
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(6, text.length - dot - 1);
}

/** 1, 2, 5, 10, 20, 50 and so on, from `from` up. */
function niceSteps(from: number): number[] {
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(from)); e <= 7; e++) {
    for (const m of [1, 2, 5]) if (m * 10 ** e >= from * (1 - 1e-9)) out.push(clean(m * 10 ** e));
  }
  return out;
}

/**
 * A range around a value that has none: about half to double, on a step that keeps the grid on the value. A whole number
 * stays whole and at least 1, so it is always a length the parser accepts; a percentage stays above 0 and below 100%.
 */
function around(v: number, percent: boolean): SliderScale {
  const whole = !percent && Number.isInteger(v);
  let lo = 0;
  let hi = 10;
  if (v > 0) {
    lo = v / 2;
    hi = percent ? Math.max(v, Math.min(2 * v, 99)) : 2 * v;
    if (whole) {
      lo = Math.max(1, Math.ceil(lo));
      hi = Math.min(MAX_PERIOD, Math.max(hi, v + 4));
    }
  } else if (v < 0) {
    lo = 2 * v;
    hi = v / 2;
  }
  const unit = whole ? 1 : Math.min(0.1, 10 ** -decimals(v));
  const candidates = percent ? [unit, 1, 5, 10, 50].filter((c) => c >= unit * (1 - 1e-9)) : niceSteps(unit);
  const limit = whole ? MAX_POSITIONS.whole : percent ? MAX_POSITIONS.percent : MAX_POSITIONS.other;
  const positions = (step: number) => Math.floor((hi - lo) / step + 1e-9) + 1;
  const step = candidates.find((c) => positions(c) <= limit) ?? candidates[candidates.length - 1];
  return { lo: clean(v - Math.floor((v - lo) / step + 1e-9) * step), hi: clean(v + Math.floor((hi - v) / step + 1e-9) * step), step };
}

/**
 * The slider for a parameter, built for the value the block declares. With a declared range, that range; the grid starts at
 * the first step that lands on the declared value, because the block's value need not sit on a step and a slider can only
 * show the values its steps reach. Without one, a range worked out from the value.
 */
export function sliderScale(p: Param): SliderScale {
  const v = shown(p, p.declared);
  if (!p.range) return around(v, p.percent);
  const { lo, hi, step } = { lo: shown(p, p.range.lo), hi: shown(p, p.range.hi), step: shown(p, p.range.step) };
  return { lo: clean(v - Math.floor((v - lo) / step + 1e-9) * step), hi, step };
}

/** The values on a slider, in order, as the language holds them (fractions for percentages). */
export function sliderValues(p: Param): number[] {
  const { lo, hi, step } = sliderScale(p);
  const count = Math.floor((hi - lo) / step + 1e-9) + 1;
  return Array.from({ length: count }, (_, k) => stored(p, clean(lo + k * step)));
}

/** The line under the bar when what is on screen differs from the block. */
export function differenceText(params: Param[], values: Record<string, number>): string | null {
  const changed = params.filter((p) => clean(values[p.name]) !== clean(p.declared));
  if (changed.length === 0) return null;
  const list = (value: (p: Param) => number) => changed.map((p) => `${p.name} ${formatParam(p, value(p))}`).join(', ');
  return `Showing ${list((p) => values[p.name])}. The block says ${list((p) => p.declared)}.`;
}

export interface ParamBarInput {
  /** The block's parameters as written. */
  params: Param[];
  hook: ParamsHook;
  /** Draws a run. `settled` is false while a slider is still being dragged: the caller may redraw only part of the result. */
  show(out: RunOutput, settled: boolean): void;
}

let nextId = 0;

/** An error's message as a sentence: messages in this plugin do not end with a full stop. */
const sentence = (e: unknown) => `${(e instanceof Error ? e.message : String(e)).replace(/[.\s]+$/, '')}.`;

/** The "Parameters" bar. The bar is built once and never redrawn, so the slider under a finger survives. Returns a cleanup function. */
export function renderParamBar(parent: HTMLElement, input: ParamBarInput): () => void {
  const { params, hook } = input;
  const bar = h(parent, 'div', 'bt-params');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Parameters');
  h(bar, 'div', 'bt-params-title', 'Parameters');

  const wanted: Record<string, number> = Object.fromEntries(params.map((p) => [p.name, p.declared]));
  let onScreen: Record<string, number> = { ...wanted };

  const rows = params.map((p) => {
    const id = `bt-param-${++nextId}`;
    const scale = sliderScale(p);
    const row = h(bar, 'div', 'bt-param');
    h(row, 'label', 'bt-param-name', p.name).htmlFor = id;
    const slider = h(row, 'input', 'bt-param-slider');
    slider.id = id;
    slider.type = 'range';
    slider.min = String(scale.lo);
    slider.max = String(scale.hi);
    slider.step = String(scale.step);
    const value = h(row, 'span', 'bt-param-value');
    const set = (v: number) => {
      slider.value = String(shown(p, v));
      value.textContent = formatParam(p, v);
      slider.setAttribute('aria-valuetext', value.textContent);
    };
    set(p.declared);
    return { p, slider, value, set };
  });

  const diff = h(bar, 'div', 'bt-param-diff');
  diff.hidden = true;
  const diffText = h(diff, 'span', 'bt-param-diff-text');
  const diffButtons = h(diff, 'span', 'bt-param-diff-buttons');
  const reset = h(diffButtons, 'button', 'bt-button', 'Reset');
  const write = hook.apply ? h(diffButtons, 'button', 'bt-button', 'Write these values to the block') : null;
  const problem = h(bar, 'div', 'bt-param-problem');
  problem.hidden = true;
  problem.setAttribute('aria-live', 'polite');

  const say = (text: string | null) => {
    problem.hidden = text === null;
    problem.textContent = text;
  };
  const showDifference = () => {
    const text = differenceText(params, onScreen);
    diff.hidden = text === null;
    diffText.textContent = text;
  };

  let latest = 0;
  let frame = 0;
  let last: RunOutput | null = null;
  let lastSettled = true;
  const request = (settled: boolean) => {
    const values = { ...wanted };
    const seq = ++latest;
    hook.rerun(values).then(
      (out) => {
        // An answer that arrives after a newer request was made is out of date.
        if (seq !== latest) return;
        say(null);
        onScreen = values;
        last = out;
        lastSettled = settled;
        showDifference();
        input.show(out, settled);
      },
      (e: unknown) => {
        if (seq !== latest) return;
        say(`These values do not run. ${sentence(e)} The result below is still the last one that ran.`);
        // A drag that ends on values that do not run leaves the last good result half drawn.
        if (settled && last && !lastSettled) {
          lastSettled = true;
          input.show(last, true);
        }
      },
    );
  };
  const schedule = () => {
    if (!frame) {
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        request(false);
      });
    }
  };
  const settle = () => {
    window.cancelAnimationFrame(frame);
    frame = 0;
    request(true);
  };

  for (const { p, slider, value } of rows) {
    const read = () => {
      wanted[p.name] = stored(p, slider.valueAsNumber);
      value.textContent = formatParam(p, wanted[p.name]);
      slider.setAttribute('aria-valuetext', value.textContent);
    };
    slider.addEventListener('input', () => {
      read();
      schedule();
    });
    slider.addEventListener('change', () => {
      read();
      settle();
    });
  }

  reset.addEventListener('click', () => {
    for (const { p, set } of rows) {
      wanted[p.name] = p.declared;
      set(p.declared);
    }
    settle();
    rows[0].slider.focus();
  });
  write?.addEventListener('click', () => {
    const values = { ...onScreen };
    reset.disabled = write.disabled = true;
    hook.apply!(values).then(
      () => {
        reset.disabled = write.disabled = false;
      },
      (e: unknown) => {
        reset.disabled = write.disabled = false;
        say(`Couldn't write the values to the block. ${sentence(e)}`);
      },
    );
  });

  return () => {
    window.cancelAnimationFrame(frame);
    latest++;
  };
}
