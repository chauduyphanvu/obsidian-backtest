import { EXAMPLES } from '../examples.ts';
import { PORTFOLIO_EXAMPLES } from './examples-portfolio.ts';
import { SINGLE_EXAMPLES } from './examples-single.ts';
import type { CorpusExample } from './types.ts';

const PROMPT_TAGS: string[][] = [['trend', 'costs'], ['portfolio', 'trend', 'stops', 'sections'], ['mean reversion', 'exits', 'stops'], ['rotation', 'ranking', 'trend'], ['parameters', 'trend', 'test period'], ['shorts', 'leverage', 'unsupported']];

/** The drafting prompt's worked examples come first, as they are in the prompt. */
const FROM_PROMPT: CorpusExample[] = EXAMPLES.map((e, i) => ({
  title: e.source.match(/^name: (.+)$/m)![1],
  description: e.description,
  source: e.source,
  notes: e.notes,
  tags: PROMPT_TAGS[i],
  prompt: true,
}));

/** Every worked example: requests in plain English and the blocks that answer them. */
export const CORPUS: CorpusExample[] = [...FROM_PROMPT, ...SINGLE_EXAMPLES, ...PORTFOLIO_EXAMPLES];
