// A result's sections as tabs. Each section is still a <details> that builds its content the first time it opens (and
// the preview panel still remembers which are open by their summaries); the tabs above them open one at a time and hide
// the summaries. A section with a preview (`data-bt-preview`) gets a large tab with that line under its name, the rest
// a small one in the row after them.

import { h, holdHeight, onWidth, s } from './dom.ts';

/** Gives a section the name its tab shows, when that differs from its summary, and the line under it. */
export function tabInfo(details: HTMLElement, name: string, preview?: string): void {
  details.setAttribute('data-bt-tab', name);
  if (preview) details.setAttribute('data-bt-preview', preview);
}

let tabs = 0;

/** The name a section's tab shows, or null for no section. */
export const tabName = (d: Element | null): string | null => (d ? (d.getAttribute('data-bt-tab') ?? d.querySelector('summary')?.textContent ?? '') : null);

/** The sections directly in `host`. */
export const sectionsIn = (host: Element | null): HTMLDetailsElement[] =>
  host?.children ? Array.from(host.children as ArrayLike<Element>).filter((c): c is HTMLDetailsElement => c.tagName?.toLowerCase() === 'details') : [];

/** The tools in the order "Test the idea" lists them: the tests first, then the views, then the versions. */
const TOOL_ORDER = ['Was it luck?', 'Try other values', 'Rule values, bar by bar', 'Prices and trades', 'Versions'];

type Mark = [keyof SVGElementTagNameMap, Record<string, string | number>];
const LINE = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
const dot = (cx: number, cy: number): Mark => ['circle', { cx, cy, r: 1.1, fill: 'currentColor' }];

/** Each tool's icon, 16 by 16, drawn with the text's colour. */
const TOOL_ICONS: Record<string, Mark[]> = {
  'Was it luck?': [['rect', { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2.5, ...LINE }], dot(5.8, 5.8), dot(10.2, 10.2), dot(10.2, 5.8), dot(5.8, 10.2)],
  'Try other values': [['path', { d: 'M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z', ...LINE, 'stroke-width': 1.3 }]],
  'Rule values, bar by bar': [['path', { d: 'M3 4h10M3 8h10M3 12h6', ...LINE }]],
  'Prices and trades': [['path', { d: 'M4.5 3v10M4.5 5.5h-1.5v5h3v-5zM11.5 3v10M11.5 4.5h-1.5v4h3v-4z', ...LINE, 'stroke-width': 1.3 }]],
  Versions: [['circle', { cx: 8, cy: 8, r: 5.5, ...LINE }], ['path', { d: 'M8 5v3.2l2 1.4', ...LINE }]],
};

function toolIcon(parent: HTMLElement, name: string): void {
  const marks = TOOL_ICONS[name];
  if (!marks) return;
  const svg = s(parent, 'svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  for (const [tag, attrs] of marks) s(svg, tag, attrs);
}

/**
 * Turns the <details> directly in `host` into tabs: the sections with a preview line as an underlined row over them, the
 * rest as round tools under them, under "Test the idea". A tab opens in the same place either way. The other things in
 * `host` stay where they are. Returns a cleanup function.
 */
export function tabify(host: HTMLElement): () => void {
  const sections = sectionsIn(host);
  if (sections.length === 0) return () => {};
  host.classList.add('bt-tabbed');
  const bar = createDiv();
  bar.className = 'bt-tabbar';
  host.prepend(bar);
  const main = h(bar, 'div', 'bt-tabs-main');
  main.setAttribute('role', 'tablist');
  main.setAttribute('aria-label', 'More about this result');
  // The line under the open tab slides from the tab before it.
  const line = h(main, 'span', 'bt-tab-line');
  line.setAttribute('aria-hidden', 'true');
  const more = h(host, 'div', 'bt-tabs-more');
  more.setAttribute('role', 'tablist');
  more.setAttribute('aria-label', 'Test the idea');
  h(more, 'span', 'bt-tabs-more-label', 'Test the idea');

  const buttons = new Map<HTMLDetailsElement, HTMLButtonElement>();
  let release: (() => void) | null = null;
  const placeLine = () => {
    const open = sections.find((d) => d.open);
    const b = open ? buttons.get(open) : undefined;
    const shown = !!b && b.parentElement === main && b.offsetWidth > 0;
    line.classList.toggle('bt-tab-line-on', shown);
    if (!shown) return;
    line.style.setProperty('width', `${b.offsetWidth - 24}px`);
    line.style.setProperty('transform', `translateX(${b.offsetLeft + 12}px)`);
  };
  const sync = () => {
    for (const [d, b] of buttons) b.setAttribute('aria-selected', String(!!d.open));
    window.requestAnimationFrame(placeLine);
  };
  const order = (d: HTMLDetailsElement) => {
    const i = TOOL_ORDER.indexOf(tabName(d) ?? '');
    return i < 0 ? TOOL_ORDER.length : i;
  };
  const tools = sections.filter((d) => d.getAttribute('data-bt-preview') === null).sort((a, b) => order(a) - order(b));
  for (const d of [...sections.filter((x) => !tools.includes(x)), ...tools]) {
    const name = tabName(d) ?? '';
    const preview = d.getAttribute('data-bt-preview');
    const button = h(preview === null ? more : main, 'button', preview === null ? 'bt-tab bt-tab-small bt-tool' : 'bt-tab');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    const n = ++tabs;
    button.id = `bt-tab-${n}`;
    d.id = `bt-tabpanel-${n}`;
    button.setAttribute('aria-controls', d.id);
    d.setAttribute('role', 'tabpanel');
    d.setAttribute('aria-labelledby', button.id);
    if (preview === null) toolIcon(button, name);
    h(button, 'span', 'bt-tab-name', name);
    if (preview !== null) h(button, 'span', 'bt-tab-preview', preview);
    buttons.set(d, button);
    // Left and right move along its row of tabs, Home and End to the row's ends; Tab still goes through them in order.
    button.addEventListener('keydown', (e) => {
      const row = Array.from(button.parentElement?.children ?? []).filter((c): c is HTMLButtonElement => c.tagName?.toLowerCase() === 'button');
      const i = row.indexOf(button);
      const to = ({ ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: row.length - 1 } as Record<string, number>)[e.key];
      if (to === undefined) return;
      e.preventDefault();
      row[(to + row.length) % row.length].focus();
    });
    button.addEventListener('click', () => {
      const opening = !d.open;
      // The space keeps its height until the new panel is built (on its toggle event), then eases to the panel's height,
      // and the panel fades up into it.
      release?.();
      release = holdHeight(host);
      for (const other of sections) if (other !== d && other.open) other.open = false;
      d.open = opening;
      d.classList.add('bt-tab-in');
      if (!opening) {
        release();
        release = null;
      }
      sync();
    });
    // Opened some other way, such as by the preview panel bringing back what was open: still one at a time.
    d.addEventListener('toggle', () => {
      if (d.open) {
        for (const other of sections) if (other !== d && other.open) other.open = false;
        release?.();
        release = null;
      }
      sync();
    });
  }
  if (more.children.length === 1) more.remove();
  sync();
  return onWidth(main, placeLine);
}
