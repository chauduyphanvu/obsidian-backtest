// A stand-in for the window the plugin runs in, as far as its timers go: the plugin calls window.setTimeout, and Node has
// no window. Each call goes to Node's timer of that moment, so node:test's mock timers still apply. Importing this installs
// it for the whole test file.

(globalThis as { window?: unknown }).window = {
  setTimeout: (f: () => void, ms?: number) => setTimeout(f, ms),
  clearTimeout: (id?: ReturnType<typeof setTimeout>) => clearTimeout(id),
};
