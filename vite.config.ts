import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const core = fileURLToPath(new URL('./src/index.ts', import.meta.url));
const srcDir = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5180,
    // The app runs same-origin in dev: the share server lives on :8787, and we
    // proxy its two surfaces so in-app publish + raw links work without CORS.
    //   POST /api/publish  -> mint a snapshot
    //   GET  /d/:id(.txt)  -> the HTML view / raw canonical bytes
    // NOTE: keys are ANCHORED REGEXES (leading ^), not bare prefixes. A bare
    // '/d' prefix-matches '/design/...' and proxies the app's own CSS to :8787,
    // which 404s and white-screens the boot. '^/d/' matches only real share URLs.
    proxy: {
      '^/api/': { target: 'http://localhost:8787', changeOrigin: true },
      '^/d/': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  resolve: {
    alias: [
      // Exact "@core" -> the M0 barrel.
      { find: /^@core$/, replacement: core },
      // "@core/<name>" -> src/<name> for the few stub modules under src/.
      { find: /^@core\//, replacement: srcDir + '/' },
    ],
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
