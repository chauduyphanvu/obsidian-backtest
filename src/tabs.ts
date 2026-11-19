// A result's sections as tabs. Each section is still a <details> that builds its content the first time it opens (and
// the preview panel still remembers which are open by their summaries); the tabs above them open one at a time and hide
// the summaries. A section with a preview (`data-bt-preview`) gets a large tab with that line under its name, the rest
// a small one in the row after them.

import { h } from './dom.ts';

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

/** Turns the <details> directly in `host` into tabs. The other things in it stay where they are. */
export function tabify(host: HTMLElement): void {
  const sections = sectionsIn(host);
  if (sections.length === 0) return;
  host.classList.add('bt-tabbed');
  const bar = document.createElement('div');
  bar.className = 'bt-tabbar';
  host.prepend(bar);
  const main = h(bar, 'div', 'bt-tabs-main');
  main.setAttribute('role', 'tablist');
  main.setAttribute('aria-label', 'More about this result');
  const more = h(bar, 'div', 'bt-tabs-more');
  more.setAttribute('role', 'tablist');
  more.setAttribute('aria-label', 'Tools for this result');
  h(more, 'span', 'bt-tabs-more-label', 'More tools');

  const buttons = new Map<HTMLDetailsElement, HTMLButtonElement>();
  const sync = () => {
    for (const [d, b] of buttons) b.setAttribute('aria-selected', String(!!d.open));
  };
  for (const d of sections) {
    const name = tabName(d) ?? '';
    const preview = d.getAttribute('data-bt-preview');
    const button = h(preview === null ? more : main, 'button', preview === null ? 'bt-tab bt-tab-small' : 'bt-tab');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    const n = ++tabs;
    button.id = `bt-tab-${n}`;
    d.id = `bt-tabpanel-${n}`;
    button.setAttribute('aria-controls', d.id);
    d.setAttribute('role', 'tabpanel');
    d.setAttribute('aria-labelledby', button.id);
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
      for (const other of sections) if (other !== d && other.open) other.open = false;
      d.open = opening;
      sync();
    });
    // Opened some other way, such as by the preview panel bringing back what was open: still one at a time.
    d.addEventListener('toggle', () => {
      if (d.open) for (const other of sections) if (other !== d && other.open) other.open = false;
      sync();
    });
  }
  if (more.children.length === 1) more.remove();
  sync();
}
