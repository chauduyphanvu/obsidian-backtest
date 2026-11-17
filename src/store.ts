// Small JSON records kept in the plugin's folder, one file per key. A record is read from disk the first time it is
// asked for, changed in memory, and written back a moment after the last change. Writing reads the file again and
// merges it with what is in memory, so a copy that a sync brought in from another device is kept, not overwritten.

/** The file operations the store needs; the plugin passes Obsidian's vault adapter. */
export interface StoreFiles {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface StoreOptions<T> {
  files: StoreFiles;
  /** The folder the records live in. */
  dir: string;
  normalize?: (path: string) => string;
  /** The record a file holds, or null when it is not one: a file from an older or newer plugin is ignored, not trusted. */
  parse: (raw: unknown) => T | null;
  /** One record from the two copies: what the file holds now, and this session's. */
  merge: (disk: T, mine: T) => T;
  /** How long after the last change to a record it is written. */
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/** A file's name for a key: the key itself can hold any character, so it is hashed (cyrb53, base 36). */
export function fileId(key: string): string {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}

interface Entry<T> {
  value: T | null;
  /** Changed since it was last written. */
  dirty: boolean;
  timer: unknown;
}

export class JsonStore<T> {
  private o: Required<Omit<StoreOptions<T>, 'normalize'>> & { normalize: (path: string) => string };
  private entries = new Map<string, Entry<T>>();
  private loading = new Map<string, Promise<T | null>>();
  /** Every write of a key waits for the one before it, so two writes never interleave their read and write. */
  private chains = new Map<string, Promise<void>>();

  constructor(opts: StoreOptions<T>) {
    this.o = {
      delayMs: 2000,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      normalize: (p) => p,
      ...opts,
    };
  }

  private path(key: string): string {
    return this.o.normalize(`${this.o.dir}/${fileId(key)}.json`);
  }

  private async readDisk(key: string): Promise<T | null> {
    const path = this.path(key);
    try {
      if (!(await this.o.files.exists(path))) return null;
      const raw = JSON.parse(await this.o.files.read(path)) as unknown;
      // A file holds its key, so two keys whose names hash alike can never read each other's record.
      if (typeof raw !== 'object' || raw === null || (raw as { key?: unknown }).key !== key) return null;
      return this.o.parse((raw as { value?: unknown }).value);
    } catch {
      return null;
    }
  }

  /** The record for `key`, from memory or else from its file; null when there is none. */
  async get(key: string): Promise<T | null> {
    const known = this.entries.get(key);
    if (known) return known.value;
    let pending = this.loading.get(key);
    if (!pending) {
      pending = this.readDisk(key);
      this.loading.set(key, pending);
    }
    const value = await pending;
    this.loading.delete(key);
    // A change made while the file was read wins over what it held.
    const now = this.entries.get(key);
    if (now) return now.value;
    this.entries.set(key, { value, dirty: false, timer: undefined });
    return value;
  }

  /** Changes the record for `key` and writes it a moment later. Resolves with the record as changed. */
  async update(key: string, change: (current: T | null) => T): Promise<T> {
    await this.get(key);
    const entry = this.entries.get(key)!;
    entry.value = change(entry.value);
    entry.dirty = true;
    this.schedule(key, entry);
    return entry.value;
  }

  /** Forgets the record for `key` and removes its file. */
  async delete(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry?.timer !== undefined) this.o.clearTimer(entry.timer);
    this.entries.set(key, { value: null, dirty: false, timer: undefined });
    await this.chain(key, async () => {
      const path = this.path(key);
      if (await this.o.files.exists(path)) await this.o.files.remove(path);
    });
  }

  /** Moves the record of `from` to `to`, merged with any record `to` already has, and removes the old file. */
  async rename(from: string, to: string): Promise<void> {
    if (from === to) return;
    const moving = await this.get(from);
    if (moving === null) return;
    await this.update(to, (current) => (current === null ? moving : this.o.merge(current, moving)));
    await this.delete(from);
  }

  /** Writes every record changed since it was last written. */
  async flush(): Promise<void> {
    const keys = [...this.entries].filter(([, e]) => e.dirty).map(([k]) => k);
    await Promise.all(keys.map((k) => this.write(k)));
  }

  private schedule(key: string, entry: Entry<T>): void {
    if (entry.timer !== undefined) this.o.clearTimer(entry.timer);
    entry.timer = this.o.setTimer(() => {
      entry.timer = undefined;
      void this.write(key);
    }, this.o.delayMs);
  }

  private chain(key: string, job: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(job, job);
    this.chains.set(key, next.catch(() => undefined));
    return next;
  }

  private write(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve();
    if (entry.timer !== undefined) {
      this.o.clearTimer(entry.timer);
      entry.timer = undefined;
    }
    return this.chain(key, async () => {
      if (!entry.dirty || entry.value === null) return;
      entry.dirty = false;
      const mine = entry.value;
      const disk = await this.readDisk(key);
      const value = disk === null ? mine : this.o.merge(disk, mine);
      // Changes made while the file was read stay changes, merged on top of what is written now.
      if (entry.value === mine) entry.value = value;
      const dir = this.o.normalize(this.o.dir);
      if (!(await this.o.files.exists(dir))) await this.o.files.mkdir(dir);
      await this.o.files.write(this.path(key), JSON.stringify({ key, value }));
    });
  }
}
