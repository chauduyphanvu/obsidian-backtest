import { Modal, type App } from 'obsidian';
import { colourSource, h } from './dom.ts';
import { blockOf, EMPTY, STARTERS, type Starter } from './gallery.ts';

export interface GalleryHost {
  /** Takes the chosen block, fences and a final newline included: puts it at the cursor of the note being edited, or makes a new note of it. */
  insert(block: string): void;
}

const CHOICES: Starter[] = [...STARTERS, EMPTY];

export class GalleryModal extends Modal {
  private host: GalleryHost;
  private selected = 0;
  private items: HTMLElement[] = [];
  private list: HTMLElement | null = null;
  private preview: HTMLElement | null = null;

  constructor(app: App, host: GalleryHost) {
    super(app);
    this.host = host;
  }

  onOpen(): void {
    this.modalEl.classList.add('bt-gallery-modal');
    this.titleEl.textContent = 'Start from a strategy';
    const root = h(this.contentEl, 'div', 'bt-gallery');
    const body = h(root, 'div', 'bt-gallery-body');

    const list = h(body, 'ul', 'bt-gallery-list');
    list.tabIndex = 0;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Starter strategies');
    CHOICES.forEach((starter, i) => {
      const item = h(list, 'li', 'bt-gallery-item');
      item.id = `bt-gallery-item-${i}`;
      item.setAttribute('role', 'option');
      h(item, 'div', 'bt-gallery-title', starter.title);
      h(item, 'div', 'bt-gallery-text', starter.description);
      item.addEventListener('click', () => this.select(i));
      item.addEventListener('dblclick', () => this.insert());
      this.items.push(item);
    });
    list.addEventListener('keydown', (e) => this.onKey(e));
    this.list = list;
    this.preview = h(body, 'div', 'bt-gallery-preview');

    const foot = h(root, 'div', 'bt-gallery-foot');
    h(foot, 'span', 'bt-gallery-hint', 'Select a strategy. Then click Insert. To insert the selected strategy immediately, double-click it or push Enter.');
    h(foot, 'button', 'mod-cta', 'Insert').addEventListener('click', () => this.insert());

    this.select(0);
    list.focus();
  }

  onClose(): void {
    this.items = [];
    this.contentEl.replaceChildren();
  }

  private onKey(e: KeyboardEvent): void {
    const last = CHOICES.length - 1;
    const to: Record<string, number> = {
      ArrowDown: Math.min(this.selected + 1, last),
      ArrowUp: Math.max(this.selected - 1, 0),
      PageDown: Math.min(this.selected + 4, last),
      PageUp: Math.max(this.selected - 4, 0),
      Home: 0,
      End: last,
    };
    if (e.key in to) {
      e.preventDefault();
      this.select(to[e.key]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.insert();
    }
  }

  private select(i: number): void {
    this.selected = i;
    this.items.forEach((item, k) => item.setAttribute('aria-selected', String(k === i)));
    this.list!.setAttribute('aria-activedescendant', this.items[i].id);
    this.items[i].scrollIntoView({ block: 'nearest' });
    const starter = CHOICES[i];
    const preview = this.preview!;
    preview.replaceChildren();
    h(preview, 'div', 'bt-gallery-name', starter.title);
    h(preview, 'p', 'bt-gallery-desc', starter.description);
    colourSource(h(preview, 'pre', 'bt-source'), starter.text);
  }

  private insert(): void {
    this.host.insert(blockOf(CHOICES[this.selected]));
    this.close();
  }
}
