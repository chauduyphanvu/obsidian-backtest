import { Modal, type App } from 'obsidian';
import { colourSource, h } from './dom.ts';
import { DRAFT_PRIVACY, type Draft } from './llm.ts';

export interface DraftHost {
  /** False when no provider is usable yet (no key or address). */
  configured(): boolean;
  openSettings(): void;
  draft(description: string, onStatus: (text: string) => void): Promise<Draft>;
  /** Inserts the block into the active note at the cursor. */
  insert(source: string): void;
}

const PLACEHOLDER = 'Example: Buy SPY when it closes above its 200-day average, sell when it falls back below, 5 bps costs.';
const FENCE = '```';

export class DraftModal extends Modal {
  private host: DraftHost;
  private input: HTMLTextAreaElement | null = null;
  private panel: HTMLElement | null = null;
  /** Counts requests: an answer that arrives after a newer request or after closing is dropped. */
  private ticket = 0;

  constructor(app: App, host: DraftHost) {
    super(app);
    this.host = host;
  }

  onOpen(): void {
    this.titleEl.textContent = 'Draft a strategy from a description';
    const root = h(this.contentEl, 'div', 'bt-llm-root');
    if (!this.host.configured()) {
      h(root, 'p', 'bt-llm-hint', 'Set up a model in the plugin settings first: an API key for Anthropic, or the address and model name of an OpenAI-compatible server.');
      h(h(root, 'div', 'bt-llm-actions'), 'button', 'mod-cta', 'Open settings').addEventListener('click', () => {
        this.close();
        this.host.openSettings();
      });
      return;
    }
    const input = h(root, 'textarea', 'bt-llm-input');
    input.rows = 4;
    input.placeholder = PLACEHOLDER;
    input.setAttribute('aria-label', 'Describe the strategy');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.submit();
      }
    });
    h(root, 'p', 'bt-llm-privacy', DRAFT_PRIVACY);
    this.input = input;
    this.panel = h(root, 'div', 'bt-llm-panel');
    this.idle();
    input.focus();
  }

  onClose(): void {
    this.ticket++;
    this.contentEl.replaceChildren();
  }

  private reset(): HTMLElement {
    const panel = this.panel!;
    panel.replaceChildren();
    return panel;
  }

  private idle(hint?: string): void {
    const panel = this.reset();
    if (hint) h(panel, 'p', 'bt-llm-hint', hint);
    h(h(panel, 'div', 'bt-llm-actions'), 'button', 'mod-cta', 'Draft').addEventListener('click', () => this.submit());
  }

  private submit(): void {
    const input = this.input!;
    const description = input.value.trim();
    if (!description) {
      this.idle('Describe the strategy first.');
      input.focus();
      return;
    }
    const ticket = ++this.ticket;
    const row = h(this.reset(), 'div', 'bt-llm-status');
    row.setAttribute('role', 'status');
    h(row, 'span', 'bt-llm-spinner');
    const status = h(row, 'span', undefined, 'Writing a draft…');
    input.disabled = true;
    this.host.draft(description, (text) => {
      if (ticket === this.ticket) status.textContent = text;
    }).then(
      (draft) => {
        if (ticket !== this.ticket) return;
        input.disabled = false;
        this.showDraft(draft);
      },
      (e: unknown) => {
        if (ticket !== this.ticket) return;
        input.disabled = false;
        this.showFailure(e instanceof Error ? e.message : String(e));
      },
    );
  }

  private showDraft(draft: Draft): void {
    const panel = this.reset();
    h(panel, 'div', 'bt-llm-label', 'Draft');
    colourSource(h(panel, 'pre', 'bt-source bt-llm-source'), draft.source);

    if (draft.notes.length > 0) {
      h(panel, 'div', 'bt-llm-label', "The model's notes");
      const list = h(panel, 'ul', 'bt-llm-notes');
      for (const note of draft.notes) h(list, 'li', undefined, note);
    }

    if (draft.errors.length > 0) {
      h(panel, 'div', 'bt-error-title bt-llm-title', 'The draft still has problems. You can insert it and fix them in the note.');
      const lines = draft.source.split('\n');
      const list = h(panel, 'ul', 'bt-errors');
      for (const e of draft.errors) {
        const li = h(list, 'li');
        h(li, 'span', 'bt-error-line', `Line ${e.line}`);
        h(li, 'span', undefined, e.message);
        const text = lines[e.line - 1]?.trim();
        if (text) h(li, 'code', 'bt-error-src', text);
      }
    }

    const actions = h(panel, 'div', 'bt-llm-actions');
    h(actions, 'button', 'mod-cta', 'Insert into note').addEventListener('click', () => {
      this.host.insert(`${FENCE}strategy\n${draft.source}\n${FENCE}\n`);
      this.close();
    });
    h(actions, 'button', undefined, 'Try again').addEventListener('click', () => this.submit());
  }

  private showFailure(message: string): void {
    const panel = this.reset();
    h(panel, 'div', 'bt-error-title bt-llm-title', "Couldn't draft a strategy");
    h(panel, 'p', 'bt-llm-message', message);
    h(h(panel, 'div', 'bt-llm-actions'), 'button', undefined, 'Try again').addEventListener('click', () => this.submit());
  }
}
