// The entry of the workers that run backtests, sweeps and luck checks. esbuild bundles it on its own and main.js carries it
// as text.

import { serve, type FromWorker, type ToWorker } from './jobs.ts';

/** The little of a dedicated worker's global scope used here: tsconfig only knows the window's. */
interface Scope {
  postMessage(message: FromWorker): void;
  onmessage: ((e: { data: ToWorker }) => void) | null;
}

const scope = self as unknown as Scope;
const handle = serve((m) => scope.postMessage(m));
scope.onmessage = (e) => void handle(e.data);
scope.postMessage({ type: 'ready' });
