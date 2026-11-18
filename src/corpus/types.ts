/** A request in plain English and the block that answers it, as a writer should reply. */
export interface CorpusExample {
  /** Short and unique; it reads like a heading. */
  title: string;
  /** What a user would ask for, in their words. */
  description: string;
  /** The block: settings, parameters and definitions, then rules. It parses with no problems. */
  source: string;
  /** The NOTE lines a writer adds after the block: what it chose or left out. Without the "NOTE: " prefix. */
  notes: string[];
  /** Topics, such as trend, mean reversion, rotation, calendar, exits, shorts, leverage, csv, fred, intraday. */
  tags: string[];
  /** One of the drafting prompt's worked examples (src/examples.ts). */
  prompt?: true;
}

/** A block with a mistake, what the parser says about it, and the block put right. */
export interface CorpusMistake {
  title: string;
  /** The rule of the language it breaks, in one sentence. */
  why: string;
  broken: string;
  /** Exactly what the parser reports for `broken`, in order: 1-based line and message. */
  errors: { line: number; message: string }[];
  /** `broken` with the mistake put right and nothing else changed that need not change. It parses with no problems. */
  fixed: string;
}
