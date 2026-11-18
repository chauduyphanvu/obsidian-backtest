import { PORTFOLIO_MISTAKES } from './mistakes-portfolio.ts';
import { SINGLE_MISTAKES } from './mistakes-single.ts';
import type { CorpusMistake } from './types.ts';

/** Blocks with a mistake a writer is likely to make, what the parser says, and the block put right. */
export const MISTAKES: CorpusMistake[] = [...SINGLE_MISTAKES, ...PORTFOLIO_MISTAKES];
