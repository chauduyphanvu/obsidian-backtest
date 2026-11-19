// A stand-in for the page, as far as the result views use it: elements with classes, attributes, children, listeners
// and a fixed width, and the globals they reach for. Importing this installs it for the whole test file.

export const WIDTH = 600;

export class El {
  tag: string;
  className = '';
  open = false;
  hidden = false;
  disabled = false;
  type = '';
  title = '';
  id = '';
  value = '';
  min = '';
  max = '';
  checked = false;
  colSpan = 1;
  scope = '';
  tabIndex = 0;
  scrollTop = 0;
  clientWidth = WIDTH;
  offsetWidth = 120;
  offsetHeight = 20;
  attrs: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  children: (El | string)[] = [];
  parent: El | null = null;
  style = {
    left: '',
    right: '',
    top: '',
    width: '',
    props: {} as Record<string, string>,
    setProperty(k: string, v: string) {
      this.props[k] = v;
    },
    removeProperty(k: string) {
      if (k === 'left' || k === 'right' || k === 'top' || k === 'width') this[k] = '';
      else delete this.props[k];
    },
  };
  classList = {
    add: (c: string) => this.setClass(c, true),
    remove: (c: string) => this.setClass(c, false),
    toggle: (c: string, on?: boolean) => this.setClass(c, on ?? !this.classes().includes(c)),
    contains: (c: string) => this.classes().includes(c),
  };
  constructor(tag: string) {
    this.tag = tag;
  }
  get tagName(): string {
    return this.tag.toUpperCase();
  }
  classes(): string[] {
    return this.className.split(' ').filter(Boolean);
  }
  private setClass(c: string, on: boolean): void {
    const rest = this.classes().filter((x) => x !== c);
    this.className = (on ? [...rest, c] : rest).join(' ');
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  // As on the page, null clears the text.
  set textContent(text: string | null) {
    this.children = text === null ? [] : [text];
  }
  // As on the page, a node put somewhere leaves the place it was in.
  appendChild(child: El): El {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...nodes: (El | string)[]): void {
    for (const n of nodes) {
      if (typeof n !== 'string') {
        n.remove();
        n.parent = this;
      }
      this.children.push(n);
    }
  }
  prepend(node: El): void {
    node.remove();
    node.parent = this;
    this.children.unshift(node);
  }
  replaceChildren(...nodes: (El | string)[]): void {
    this.children = [];
    this.append(...nodes);
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  after(node: El): void {
    const list = this.parent!.children;
    list.splice(list.indexOf(this) + 1, 0, node);
    node.parent = this.parent;
  }
  get parentElement(): El | null {
    return this.parent;
  }
  get previousElementSibling(): El | null {
    const els = (this.parent?.children ?? []).filter((c): c is El => typeof c !== 'string');
    return els[els.indexOf(this) - 1] ?? null;
  }
  get tHead(): El | undefined {
    return this.children.find((c): c is El => typeof c !== 'string' && c.tag === 'thead');
  }
  focus(): void {
    (globalThis.document as unknown as { activeElement: El | null }).activeElement = this;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
  addEventListener(type: string, listener: (e: unknown) => void, opts?: { once?: boolean }): void {
    const list = (this.listeners[type] ??= []);
    const wrapped = opts?.once ? (e: unknown) => { this.listeners[type] = list.filter((l) => l !== wrapped); listener(e); } : listener;
    list.push(wrapped);
  }
  dispatch(type: string, e: unknown = {}): void {
    for (const listener of [...(this.listeners[type] ?? [])]) listener(e);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: WIDTH, bottom: 300, width: WIDTH, height: 300 };
  }
  all(): El[] {
    return [this, ...this.children.flatMap((c) => (typeof c === 'string' ? [] : c.all()))];
  }
  querySelector(selector: string): El | null {
    const match = (e: El) => (selector.startsWith('.') ? e.classes().includes(selector.slice(1)) : e.tag === selector);
    return this.all().slice(1).find(match) ?? null;
  }
  /** Every element under this one with the class. */
  byClass(cls: string): El[] {
    return this.all().filter((e) => e.classes().includes(cls));
  }
  has(text: string): boolean {
    return this.textContent.includes(text);
  }
}

// Each test file runs in a process of its own, so the page stays a stand-in for the whole run of the file that imports this.
(globalThis as { document?: unknown }).document = { activeElement: null, createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag) };
(globalThis as { window?: unknown }).window = { requestAnimationFrame: (f: (t: number) => void) => (f(0), 0), cancelAnimationFrame: () => {} };
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  private seen: (entries: { contentRect: { width: number } }[]) => void;
  constructor(seen: (entries: { contentRect: { width: number } }[]) => void) {
    this.seen = seen;
  }
  observe(): void {
    this.seen([{ contentRect: { width: WIDTH } }]);
  }
  disconnect(): void {}
};
