// What a reader can do with a result besides reading it: save it (in the ⋯ menu at the top of the card) and run it
// forward (the card's closing step).

import { h, s } from './dom.ts';

export interface Action {
  label: string;
  /** The icon of its menu item, by its name in Obsidian's icon set. */
  icon: string;
  run: () => void | Promise<void>;
}

/** The items of a result's menu; null draws a separator. */
export type MenuItems = (Action | null)[];

/**
 * The step that closes a result: a short title and sentence that say what it does, and its button. It is drawn once per
 * result, under the tools, so the card ends on what to do next rather than on a row of buttons.
 */
export function renderNextStep(parent: HTMLElement, o: { title: string; text: string; action: Action }): void {
  const box = h(parent, 'div', 'bt-nextstep');
  const words = h(box, 'div', 'bt-nextstep-text');
  h(words, 'span', 'bt-nextstep-title', o.title);
  h(words, 'span', undefined, o.text);
  const button = h(box, 'button', 'bt-button bt-nextstep-button');
  button.type = 'button';
  button.append(o.action.label);
  const svg = s(button, 'svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' });
  s(svg, 'path', { d: 'M2 6h7.5M6.5 3L9.5 6l-3 3', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  button.addEventListener('click', () => {
    button.disabled = true;
    void Promise.resolve(o.action.run()).finally(() => (button.disabled = false));
  });
}
