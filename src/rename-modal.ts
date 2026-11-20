import { Modal, type App } from 'obsidian';
import { h } from './dom.ts';

export interface RenameHost {
  /** The strategy's name now; null when it has none. */
  current: string | null;
  /** Why a name cannot be the new one (rewrite.ts nameProblem), or null when it can. */
  problem(name: string): string | null;
  /** Gives the strategy the name. The window closes when it starts. */
  rename(name: string): void;
}

/** Asks for a strategy's new name, and says why a name cannot be it. */
export class RenameModal extends Modal {
  private host: RenameHost;

  constructor(app: App, host: RenameHost) {
    super(app);
    this.host = host;
  }

  onOpen(): void {
    this.titleEl.textContent = this.host.current === null ? 'Give the strategy a name' : `Rename "${this.host.current}"`;
    const root = h(this.contentEl, 'div', 'bt-llm-root');
    const input = h(root, 'input', 'bt-rename-input');
    input.type = 'text';
    input.value = this.host.current ?? '';
    input.setAttribute('aria-label', 'New name of the strategy');
    const hint = h(
      root,
      'p',
      'bt-llm-hint',
      this.host.current === null ? 'The plugin then counts the tries of the strategy and keeps its versions under this name.' : 'The record of tries and the links to the strategy change to the new name.',
    );
    hint.setAttribute('role', 'status');
    const submit = () => {
      const problem = this.host.problem(input.value);
      if (problem) {
        hint.textContent = problem;
        input.focus();
        return;
      }
      this.close();
      this.host.rename(input.value.trim());
    };
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      submit();
    });
    h(h(root, 'div', 'bt-llm-actions'), 'button', 'mod-cta', 'Rename').addEventListener('click', submit);
    input.focus();
    input.select();
  }

  onClose(): void {
    this.contentEl.replaceChildren();
  }
}
