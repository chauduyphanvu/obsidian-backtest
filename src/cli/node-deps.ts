import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { withoutQueries, type DataDeps } from '../data.ts';
import { PriceStore } from '../price-store.ts';

/** Where prices are saved between runs: $XDG_CACHE_HOME/backtest-blocks, or ~/.cache/backtest-blocks. */
export const defaultCacheDir = (env: NodeJS.ProcessEnv): string => join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'backtest-blocks');

/**
 * What the engine reads from outside, on Node instead of Obsidian: prices over the network, saved under `cacheDir`, CSV
 * files under `vault`, and the Tiingo and FRED keys from TIINGO_API_KEY and FRED_API_KEY.
 */
export function nodeDeps(o: { vault: string; cacheDir: string; env: NodeJS.ProcessEnv; fetch?: typeof fetch }): DataDeps {
  const get = o.fetch ?? fetch;
  // The engine names CSV files as the vault does, from its root; the cache folder is given whole.
  const at = (path: string) => (isAbsolute(path) ? path : join(o.vault, path));
  const store = new PriceStore({
    files: {
      exists: (path) => stat(at(path)).then(() => true, () => false),
      read: (path) => readFile(at(path), 'utf8'),
      write: (path, text) => writeFile(at(path), text),
      mkdir: async (path) => {
        await mkdir(at(path), { recursive: true });
      },
      rmdir: (path, recursive) => rm(at(path), { recursive, force: true }),
    },
    cacheDir: o.cacheDir,
    normalize,
    fetchText: async (url, headers) => {
      let res: Response;
      try {
        res = await get(url, { headers: { 'user-agent': 'backtest-blocks', ...headers } });
      } catch (e) {
        // FRED takes its key in the query, and a network error can quote the address.
        throw new Error(withoutQueries(e instanceof Error ? e.message : String(e)));
      }
      const text = await res.text();
      // The services explain a bad ticker in a JSON body, which the parsers turn into a message.
      if (res.status >= 400 && !text.trimStart().startsWith('{')) throw new Error(`HTTP ${res.status}`);
      return text;
    },
    secret: (service) => (service === 'fred' ? o.env.FRED_API_KEY : o.env.TIINGO_API_KEY) || null,
    tiingoFallback: () => false,
  });
  return store.deps();
}
