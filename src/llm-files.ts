import { ALL_DOCS, FIXED_VALUES, type Doc, type DocKind } from './docs.ts';
import { LATER_WORDS, RESERVED } from './dsl.ts';

/** One word as the word list gives it. */
const entry = (d: Doc) => ({ name: d.id, signature: d.signature, summary: d.short, text: d.text, example: d.example });
const ofKind = (kind: DocKind) => ALL_DOCS.filter((d) => d.kind === kind).map(entry);

/** Every word of the language with its form, meaning and an example, from the editor's help (docs.ts). */
export function languageJson(): string {
  const values = (setting: string) =>
    (FIXED_VALUES[setting] ?? []).map((v) => {
      const d = ALL_DOCS.find((x) => x.id === `${setting}=${v}`);
      return { value: v, summary: d?.short ?? '', text: d?.text ?? '' };
    });
  const list = {
    about:
      'The words of the Backtest Blocks strategy language. Functions, series, calendar and position values go in conditions; settings are "key: value" lines; words are the rest of the rule language. A parameter or definition name is letters, digits and underscores, starting with a letter or underscore, and is not one of "reserved".',
    functions: ofKind('function'),
    series: ofKind('series'),
    calendar: ofKind('calendar'),
    position: ofKind('position'),
    settings: ALL_DOCS.filter((d) => d.kind === 'setting').map((d) => ({ ...entry(d), ...(FIXED_VALUES[d.id] ? { values: values(d.id) } : {}) })),
    words: ofKind('word'),
    units: ofKind('unit'),
    reserved: [...RESERVED].sort(),
    laterWords: {
      about: 'Words added after 0.7.0. A block may still use one as a parameter or definition name, which it then means in that block; calling it as a function there is an error.',
      words: [...LATER_WORDS].sort(),
    },
  };
  return `${JSON.stringify(list, null, 2)}\n`;
}

/** The files written for language models and tools, by their path in the repository. */
export function generatedFiles(): Record<string, string> {
  return {
    'docs/language.json': languageJson(),
  };
}
