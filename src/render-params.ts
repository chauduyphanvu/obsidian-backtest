import { h } from './dom.ts';
import { MAX_PERIOD, type Param } from './dsl.ts';
import { tidy } from './format.ts';
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
  /**
   * Values are keyed by parameter name, as fractions for percentages. `settled` is false while a slider is still being dragged.
   * Rejects with a plain message when the block does not run with them. Resolves with null, having fetched nothing, when
   * `settled` is false and the values need more price history than is loaded: that waits for the release.
   */
  rerun(values: Record<string, number>, settled: boolean): Promise<RunOutput | null>;
  /** Present only where the block can be edited. Rejects with a message fit to show when nothing was written. */
  apply?: (values: Record<string, number>) => Promise<void>;
  /** False when a run would hold up the window if it were done on every frame of a drag: the block then runs only when the slider is let go. */
  followsDrag?: () => boolean;
  /**
   * Whether the block reads, without running it, with these values. Asked while the bar is built, to keep a slider that has
   * no range of its own to values the language accepts. Without it such a slider offers every value from about half to double.
   */
  accepts?: (values: Record<string, number>) => boolean;
  /**
   * The returns of a parameter sweep of this block, once one has run: the slider tracks are painted with them. Calls
   * `listen` with what is known now and again when a sweep finishes; returns a function that stops listening.
   */
  sweep?: (listen: (paint: TrackPaint) => void) => () => void;
}

/** What a sweep found, cut down to what a slider's track shows: each variant's values and its return per year. */
export interface TrackPaint {
  params: { name: string; values: number[] }[];
  points: { values: Record<string, number>; cagr: number }[];
}

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * The return per year at each value of `name` that the sweep tried, with every other parameter where it is now (`now`):
 * null when the sweep did not try that place, as when another parameter is off its grid, or one it did not sweep is
 * not at its declared value.
 */
export function trackOf(paint: TrackPaint, name: string, now: Record<string, number>, declared: Record<string, number>): { value: number; cagr: number }[] | null {
  const mine = paint.params.find((q) => q.name === name);
  if (!mine) return null;
  for (const [other, v] of Object.entries(now)) {
    if (other === name) continue;
    const swept = paint.params.find((q) => q.name === other);
    if (swept ? !swept.values.some((x) => same(x, v)) : !same(v, declared[other])) return null;
  }
  const out = mine.values.map((value) => {
    const point = paint.points.find((p) => same(p.values[name], value) && paint.params.every((q) => q.name === name || same(p.values[q.name], now[q.name])));
    return { value, cagr: point ? point.cagr : NaN };
  });
  return out.some((x) => Number.isFinite(x.cagr)) ? out : null;
}

const shown = (p: Pick<Param, 'percent'>, value: number) => tidy(p.percent ? value * 100 : value);
const stored = (p: Pick<Param, 'percent'>, x: number) => tidy(p.percent ? x / 100 : x);

/** A value the way the block writes it: `50`, `8%`, `6.5%`. */
export function formatParam(p: Pick<Param, 'percent'>, value: number): string {
  return plainNumber(shown(p, value)) + (p.percent ? '%' : '');
}

/** Most positions a slider offers, so the step stays easy to hit and to walk with the arrow keys. */
const MAX_POSITIONS = { whole: 120, percent: 100, other: 60 };

function decimals(x: number): number {
  const text = String(tidy(Math.abs(x)));
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(6, text.length - dot - 1);
}

/** 1, 2, 5, 10, 20, 50 and so on, from `from` up. */
function niceSteps(from: number): number[] {
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(from)); e <= 7; e++) {
    for (const m of [1, 2, 5]) if (m * 10 ** e >= from * (1 - 1e-9)) out.push(tidy(m * 10 ** e));
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
  return { lo: tidy(v - Math.floor((v - lo) / step + 1e-9) * step), hi: tidy(v + Math.floor((hi - v) / step + 1e-9) * step), step };
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
  return { lo: tidy(v - Math.floor((v - lo) / step + 1e-9) * step), hi, step };
}

/**
 * `sliderScale`, with a range worked out from the value cut back to the values the block accepts: `accepts` says whether it
 * still reads with the parameter at a value (in the language's units), and an end it refuses moves in a step at a time
 * until it does. A declared range is the block's own, so it is left as written. The value the block declares is never cut.
 */
export function acceptedScale(p: Param, accepts: (value: number) => boolean): SliderScale {
  const scale = sliderScale(p);
  if (p.range) return scale;
  const v = shown(p, p.declared);
  const near = (x: number) => Math.abs(x - v) < scale.step / 2;
  let { lo, hi } = scale;
  while (!near(hi) && !accepts(stored(p, hi))) hi = tidy(hi - scale.step);
  while (!near(lo) && !accepts(stored(p, lo))) lo = tidy(lo + scale.step);
  return { ...scale, lo, hi };
}

/** The values on a slider, in order, as the language holds them (fractions for percentages). */
export function sliderValues(p: Param): number[] {
  const { lo, hi, step } = sliderScale(p);
  const count = Math.floor((hi - lo) / step + 1e-9) + 1;
  return Array.from({ length: count }, (_, k) => stored(p, tidy(lo + k * step)));
}

/** The line under the bar when what is on screen differs from the block. */
export function differenceText(params: Param[], values: Record<string, number>): string | null {
  const changed = params.filter((p) => tidy(values[p.name]) !== tidy(p.declared));
  if (changed.length === 0) return null;
  const list = (value: (p: Param) => number) => changed.map((p) => `${p.name} ${formatParam(p, value(p))}`).join(', ');
  return `The result shows ${list((p) => values[p.name])}. The values in the block are ${list((p) => p.declared)}.`;
}

export interface ParamBarInput {
  /** The block's parameters as written. */
  params: Param[];
  hook: ParamsHook;
  /** Draws a run. `settled` is false while a slider is still being dragged: the caller may redraw only part of the result. */
  show(out: RunOutput, settled: boolean): void;
  /** The numbers of the parameters' lines in the block's text, by parameter name in lower case, to drag like the sliders. */
  scrubs?: Map<string, HTMLElement>;
}

/** What the bar does with the answers to the runs it asks for. */
export interface RequesterHandlers {
  /** A run for these values is the one to show. */
  shown(out: RunOutput, values: Record<string, number>, settled: boolean): void;
  /** The latest drag position needs history that is not loaded; nothing was fetched, and the release will fetch it. */
  waiting(): void;
  /** A release is fetching the history a drag was waiting for. */
  loading(): void;
  failed(error: unknown, settled: boolean): void;
}

/**
 * Asks the hook for runs as the sliders move, one at a time: a request made while a run is out waits for it, and replaces
 * any request already waiting, so a slow block never builds up a queue. The latest request is the one answered. An older
 * answer is dropped, except a run of a drag that the drag has moved past while it ran: that one is shown while the slider
 * is still moving, so a block slower than a frame still follows it.
 */
export function createRequester(hook: Pick<ParamsHook, 'rerun'>, on: RequesterHandlers): { request(values: Record<string, number>, settled: boolean): void; cancel(): void } {
  let latest = 0;
  let latestSettled = false;
  let waiting = false;
  let busy = false;
  let queued: { values: Record<string, number>; settled: boolean; seq: number } | null = null;

  const send = (asked: Record<string, number>, settled: boolean, seq: number): void => {
    busy = true;
    // A failure while drawing an answer is reported like one while asking, so it is never left unhandled.
    hook
      .rerun(asked, settled)
      .then((out) => {
        if (seq !== latest) {
          if (out !== null && !settled && !latestSettled) {
            waiting = false;
            on.shown(out, asked, false);
          }
          return;
        }
        waiting = out === null;
        if (out === null) on.waiting();
        else on.shown(out, asked, settled);
      })
      .catch((e: unknown) => {
        if (seq !== latest) return;
        waiting = false;
        on.failed(e, settled);
      })
      .finally(() => {
        busy = false;
        const after = queued;
        queued = null;
        if (after) send(after.values, after.settled, after.seq);
      });
  };

  return {
    request(values, settled) {
      const asked = { ...values };
      const seq = ++latest;
      latestSettled = settled;
      if (settled && waiting) on.loading();
      if (busy) queued = { values: asked, settled, seq };
      else send(asked, settled, seq);
    },
    cancel() {
      latest++;
      latestSettled = true;
      queued = null;
    },
  };
}

let nextId = 0;

/** An error's message as a sentence: messages in this plugin do not end with a full stop. */
const sentence = (e: unknown) => `${(e instanceof Error ? e.message : String(e)).replace(/[.\s]+$/, '')}.`;

const WAITING = 'For this value, the plugin must load more price history. The result does not change. The plugin loads the history when you release the slider.';
const LOADING = 'More price history loads…';
const ON_RELEASE = 'This strategy is too slow to run again at each step of a drag. It runs when you release the slider.';

const HINT_PAINTED = 'Track colour: return per year of each value, from Try other values. The tick is the value in the block.';
const HINT = 'Drag a number in the rules, or use a slider.';

/** Pixels of drag for one step of a number in the rules. */
const SCRUB_STEP_PX = 16;

/**
 * The parameters: a slider for each, the numbers in the rules (`scrubs`, by parameter name) that drag the same way, and one
 * line of fixed height under them for what to do when the result on screen differs from the block. Nothing under the bar
 * moves while a slider is dragged. The bar is built once and never redrawn, so the slider under a finger survives.
 * Returns a cleanup function.
 */
export function renderParamBar(parent: HTMLElement, input: ParamBarInput): () => void {
  const { params, hook } = input;
  const bar = h(parent, 'div', 'bt-params');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Parameters');

  const declared: Record<string, number> = Object.fromEntries(params.map((p) => [p.name, p.declared]));
  const wanted = { ...declared };
  const accepts = hook.accepts;
  let onScreen: Record<string, number> = { ...wanted };

  const rows = params.map((p) => {
    const id = `bt-param-${++nextId}`;
    const scale = accepts ? acceptedScale(p, (x) => accepts({ ...declared, [p.name]: x })) : sliderScale(p);
    const row = h(bar, 'div', 'bt-param');
    h(row, 'label', 'bt-param-name', p.name).htmlFor = id;
    const slider = h(row, 'input', 'bt-param-slider');
    slider.id = id;
    slider.type = 'range';
    slider.min = String(scale.lo);
    slider.max = String(scale.hi);
    slider.step = String(scale.step);
    const value = h(row, 'span', 'bt-param-value');
    const scrub = input.scrubs?.get(p.name.toLowerCase()) ?? null;
    const set = (v: number) => {
      slider.value = String(shown(p, v));
      value.textContent = formatParam(p, v);
      slider.setAttribute('aria-valuetext', value.textContent);
      if (scrub) {
        scrub.textContent = formatParam(p, v);
        scrub.setAttribute('aria-valuenow', String(shown(p, v)));
        scrub.setAttribute('aria-valuetext', formatParam(p, v));
        scrub.classList.toggle('bt-scrub-changed', tidy(v) !== tidy(p.declared));
      }
    };
    set(p.declared);
    return { p, slider, value, set, scale, scrub };
  });

  // One line of fixed height: the key to the tracks, or what differs from the block with Reset and Write, or a problem.
  const slot = h(bar, 'div', 'bt-param-slot');
  const hint = h(slot, 'div', 'bt-param-hint', HINT);
  const diff = h(slot, 'div', 'bt-param-diff');
  diff.setAttribute('aria-live', 'polite');
  const diffText = h(diff, 'span', 'bt-param-diff-text');
  const diffButtons = h(diff, 'span', 'bt-param-diff-buttons');
  const reset = h(diffButtons, 'button', 'bt-button', 'Reset');
  const write = hook.apply ? h(diffButtons, 'button', 'bt-button mod-cta', 'Write these values to the block') : null;
  const problem = h(slot, 'div', 'bt-param-problem');
  problem.setAttribute('aria-live', 'polite');
  let said: { text: string; plain: boolean } | null = null;
  const sync = () => {
    const differs = differenceText(params, onScreen);
    diffText.textContent = differs;
    const showing = said ? 'problem' : differs ? 'diff' : 'hint';
    for (const [el, name] of [[hint, 'hint'], [diff, 'diff'], [problem, 'problem']] as const) {
      el.classList.toggle('bt-slot-on', name === showing);
      el.inert = name !== showing;
    }
    problem.classList.toggle('bt-param-plain', said?.plain ?? false);
    problem.textContent = said?.text ?? '';
  };

  /** What sits under the bar: a problem, or with `plain` a note that is not one. */
  const say = (text: string | null, plain = false) => {
    said = text === null ? null : { text, plain };
    sync();
  };

  let last: RunOutput | null = null;
  let lastSettled = true;
  const requester = createRequester(hook, {
    shown(out, values, settled) {
      onScreen = values;
      last = out;
      lastSettled = settled;
      say(null);
      input.show(out, settled);
      paintTracks();
    },
    waiting: () => say(WAITING, true),
    loading: () => say(LOADING, true),
    failed(e, settled) {
      say(`These values do not run. ${sentence(e)} The result below is from the last values that ran.`);
      // A drag that ends on values that do not run leaves the last good result half drawn.
      if (settled && last && !lastSettled) {
        lastSettled = true;
        input.show(last, true);
      }
    },
  });
  let frame = 0;
  const schedule = () => {
    if (hook.followsDrag?.() === false) {
      say(ON_RELEASE, true);
      return;
    }
    if (!frame) {
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        requester.request(wanted, false);
      });
    }
  };
  const settle = () => {
    window.cancelAnimationFrame(frame);
    frame = 0;
    requester.request(wanted, true);
  };

  // The tracks: each value's return per year from a sweep, on one scale for the whole sweep, and a tick at the block's value.
  let paint: TrackPaint | null = null;
  const paintTracks = () => {
    const finite = paint ? paint.points.map((x) => x.cagr).filter(Number.isFinite) : [];
    const [lo, hi] = finite.length ? [Math.min(...finite), Math.max(...finite)] : [0, 0];
    let painted = false;
    for (const { p, slider, scale } of rows) {
      const track = paint ? trackOf(paint, p.name, onScreen, declared) : null;
      if (!track) {
        slider.style.removeProperty('--bt-track');
        slider.classList.remove('bt-painted');
        continue;
      }
      painted = true;
      const span = scale.hi - scale.lo || 1;
      const at = (v: number) => Math.min(1, Math.max(0, (shown(p, v) - scale.lo) / span));
      const where = (k: number) => `calc(var(--slider-thumb-width, 18px) / 2 + (100% - var(--slider-thumb-width, 18px)) * ${k.toFixed(4)})`;
      const stops: string[] = [];
      track.forEach((x, i) => {
        const a = i === 0 ? 0 : (at(track[i - 1].value) + at(x.value)) / 2;
        const b = i === track.length - 1 ? 1 : (at(x.value) + at(track[i + 1].value)) / 2;
        const share = Number.isFinite(x.cagr) ? Math.round(12 + (88 * (x.cagr - lo)) / (hi - lo || 1)) : 0;
        const colour = `color-mix(in srgb, var(--bt-strategy) ${share}%, transparent)`;
        stops.push(`${colour} ${a === 0 ? '0%' : where(a)}`, `${colour} ${b === 1 ? '100%' : where(b)}`);
      });
      const tick = at(p.declared);
      slider.style.setProperty('--bt-track', `linear-gradient(90deg, ${stops.join(', ')})`);
      slider.style.setProperty('--bt-tick', where(tick));
      slider.classList.add('bt-painted');
    }
    hint.textContent = painted ? HINT_PAINTED : HINT;
  };
  const unlisten = hook.sweep?.((next) => {
    paint = next;
    paintTracks();
  });

  for (const { p, slider, value } of rows) {
    const read = () => {
      wanted[p.name] = stored(p, slider.valueAsNumber);
      value.textContent = formatParam(p, wanted[p.name]);
      slider.setAttribute('aria-valuetext', value.textContent);
      rows.find((r) => r.p === p)!.set(wanted[p.name]);
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

  // A number in the rules is the same control: drag it sideways a step at a time, or use the arrow keys.
  for (const { p, scrub, scale, set } of rows) {
    if (!scrub) continue;
    scrub.classList.add('bt-scrub');
    scrub.tabIndex = 0;
    scrub.setAttribute('role', 'spinbutton');
    scrub.setAttribute('aria-label', p.name);
    scrub.setAttribute('aria-valuemin', String(scale.lo));
    scrub.setAttribute('aria-valuemax', String(scale.hi));
    const count = Math.floor((scale.hi - scale.lo) / scale.step + 1e-9);
    const indexOf = (v: number) => Math.max(0, Math.min(count, Math.round((shown(p, v) - scale.lo) / scale.step)));
    const valueAt = (k: number) => stored(p, tidy(scale.lo + Math.max(0, Math.min(count, k)) * scale.step));
    let start = 0;
    let from = 0;
    let moved = false;
    scrub.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      scrub.setPointerCapture(e.pointerId);
      start = e.clientX;
      from = indexOf(wanted[p.name]);
      moved = false;
      scrub.classList.add('bt-scrub-active');
    });
    scrub.addEventListener('pointermove', (e) => {
      if (!scrub.hasPointerCapture(e.pointerId)) return;
      const v = valueAt(from + Math.round((e.clientX - start) / SCRUB_STEP_PX));
      if (tidy(v) === tidy(wanted[p.name])) return;
      moved = true;
      wanted[p.name] = v;
      set(v);
      schedule();
    });
    const end = () => {
      scrub.classList.remove('bt-scrub-active');
      if (moved) settle();
      moved = false;
    };
    scrub.addEventListener('pointerup', end);
    scrub.addEventListener('pointercancel', end);
    scrub.addEventListener('keydown', (e) => {
      const d = ({ ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 } as Record<string, number>)[e.key];
      if (!d) return;
      e.preventDefault();
      const v = valueAt(indexOf(wanted[p.name]) + d);
      if (tidy(v) === tidy(wanted[p.name])) return;
      wanted[p.name] = v;
      set(v);
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
  write?.addEventListener('click', async () => {
    const values = { ...onScreen };
    reset.disabled = write.disabled = true;
    try {
      await hook.apply!(values);
      say(null);
    } catch (e) {
      say(`Cannot write the values to the block. ${sentence(e)}`);
    } finally {
      reset.disabled = write.disabled = false;
    }
  });
  sync();

  return () => {
    window.cancelAnimationFrame(frame);
    requester.cancel();
    unlisten?.();
  };
}
