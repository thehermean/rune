import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Keep the test runner rooted at the repo (the M0 core tests live in test/ and
// read examples/work.rune by relative URL). This is intentionally separate from
// vite.config.ts, whose `root: 'web'` is for the app build only.
//
// Mirror vite.config.ts's `@core` aliases so tests that exercise web/ modules
// (which import from '@core' / '@core/<name>') resolve the same way the app does.
const core = fileURLToPath(new URL('./src/index.ts', import.meta.url));
const srcDir = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@core$/, replacement: core },
      { find: /^@core\//, replacement: srcDir + '/' },
    ],
  },
  test: {
    root: '.',
    include: ['test/**/*.{test,spec}.ts'],
    // The store-level sync tests reset the module registry per test and re-import
    // the store + @core each time; under parallel-worker load that one-time
    // re-evaluation can momentarily exceed the 5s default. These tests are
    // import-bound, not hanging, so give them headroom to stay green under load.
    testTimeout: 20000,
  },
});
