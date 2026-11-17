import { h } from './dom.ts';

export interface Action {
  label: string;
  run: () => void | Promise<void>;
}

/** A row of buttons for things the reader can do with a result. */
export function renderActions(parent: HTMLElement, actions: Action[]): void {
  const row = h(parent, 'div', 'bt-actions');
  for (const a of actions) {
    const button = h(row, 'button', 'bt-button', a.label);
    button.addEventListener('click', () => {
      button.disabled = true;
      void Promise.resolve(a.run()).finally(() => (button.disabled = false));
    });
  }
}
