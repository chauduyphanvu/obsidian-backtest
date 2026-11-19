// Writing into the vault: a note's bt_ properties once its blocks have rendered, and new files under a name nothing has.
// The plugin hands in the vault's calls, so this runs without Obsidian.

import { extractBlocks } from './blocks.ts';
import { planProperties, propertyIds, resultProperties } from './export.ts';
import { isoDate } from './format.ts';
import { debounce } from './result-cache.ts';
import type { RunOutput } from './runner.ts';

/** How long after the last block of a note renders its properties are written, so a note with several blocks is written once. */
const PROPERTY_DELAY = 1000;

export interface PropertiesHost<F> {
  /** The note's text (Obsidian's cachedRead). */
  read(file: F): Promise<string>;
  /** The note's properties as Obsidian last read them. */
  frontmatter(file: F): Record<string, unknown> | undefined;
  processFrontMatter(file: F, edit: (fm: Record<string, unknown>) => void): Promise<void>;
  runSource(source: string, opts: { cachedOnly: boolean }): Promise<RunOutput>;
  notice(text: string): void;
}

export class NoteProperties<F extends { path: string }> {
  private propertyWrites = new Map<string, { (): void; cancel(): void }>();
  private host: PropertiesHost<F>;

  constructor(host: PropertiesHost<F>) {
    this.host = host;
  }

  /** Writes a note's properties once, a moment after the last of its blocks has rendered. */
  scheduleProperties(file: F): void {
    const path = file.path;
    let write = this.propertyWrites.get(path);
    if (!write) {
      write = debounce(() => {
        this.propertyWrites.delete(path);
        void this.saveProperties(file, false);
      }, PROPERTY_DELAY);
      this.propertyWrites.set(path, write);
    }
    write();
  }

  /** Drops the writes still waiting, for the plugin's `onunload`. */
  cancel(): void {
    for (const write of this.propertyWrites.values()) write.cancel();
  }

  /**
   * Stores the main figures of every strategy in a note in that note's properties. Only strategies that have a result are
   * written; when asked for (`announce`), strategies run first, otherwise nothing runs here.
   */
  async saveProperties(file: F, announce: boolean): Promise<void> {
    const blocks = extractBlocks(await this.host.read(file));
    const ids = propertyIds(blocks.map((b) => b.name));
    const produced: Record<string, string | number> = {};
    let ran = 0;
    for (const [i, block] of blocks.entries()) {
      try {
        const out = await this.host.runSource(block.source, { cachedOnly: !announce });
        Object.assign(produced, resultProperties(out.backtest, Date.now(), ids[i]));
        ran++;
      } catch {
        // A block that can't run has nothing to record; its own rendering shows why.
      }
    }
    if (ran === 0) {
      if (announce) this.host.notice('This note has no strategy that runs. There is nothing to save.');
      return;
    }
    const complete = ran === blocks.length;
    const none = (plan: ReturnType<typeof planProperties>) => Object.keys(plan.set).length === 0 && plan.remove.length === 0;
    if (none(planProperties(this.host.frontmatter(file), produced, complete))) {
      if (announce) this.host.notice('The properties of this note agree with the results. There is nothing to save.');
      return;
    }
    await this.host.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const plan = planProperties(fm, produced, complete);
      for (const k of plan.remove) delete fm[k];
      Object.assign(fm, plan.set);
    });
    if (announce) {
      const missed = blocks.length - ran;
      this.host.notice(`Saved ${Object.keys(produced).length} figures to the properties of this note.${missed > 0 ? ` ${missed} of ${blocks.length} strategies did not run. The plugin kept the figures from their previous runs.` : ''}`);
    }
  }
}

/** The vault's calls for new files, with paths as the vault writes them. */
export interface NewFiles {
  exists(path: string): Promise<boolean>;
  createFolder(path: string): Promise<unknown>;
  create(path: string, text: string): Promise<unknown>;
}

/** A title with the characters Obsidian cannot use in a file name replaced by spaces. */
const fileName = (title: string): string => title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();

/** Writes text to a dated file in `folder`, "<title> <date>", then "<title> <date> (2)" and on, and says where it went. */
export async function saveDatedFile(files: NewFiles, folder: string, title: string, ext: string, text: string, notice: (text: string) => void): Promise<void> {
  const clean = fileName(title);
  try {
    if (!(await files.exists(folder))) await files.createFolder(folder);
    const stem = `${folder}/${clean} ${isoDate(Date.now())}`;
    let path = `${stem}.${ext}`;
    for (let n = 2; await files.exists(path); n++) path = `${stem} (${n}).${ext}`;
    await files.create(path, text);
    notice(`Saved to ${path}`);
  } catch (e) {
    notice(`Cannot save the file: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Creates a file at `path`, or, when that is taken, with "-2", "-3" and on before its extension. Returns where it went. */
export async function createWithFreeName(files: Pick<NewFiles, 'exists' | 'create'>, path: string, text: string): Promise<string> {
  const dot = path.lastIndexOf('.');
  let free = path;
  for (let n = 2; await files.exists(free); n++) free = `${path.slice(0, dot)}-${n}${path.slice(dot)}`;
  await files.create(free, text);
  return free;
}

/** Creates the note "<title>.md" in `folder` (made when it is missing), or with "-2", "-3" and on after the title when that is taken. Returns where it went. */
export async function createNote(files: NewFiles, folder: string, title: string, text: string): Promise<string> {
  if (!(await files.exists(folder))) await files.createFolder(folder);
  return createWithFreeName(files, `${folder}/${fileName(title)}.md`, text);
}
