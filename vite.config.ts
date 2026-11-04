import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// The driver, from the lattice-swap submodule pinned in vendor/, as the
// page imports it (driver.ts).
const driver = fileURLToPath(new URL('./vendor/lattice-swap/web/driver/src/', import.meta.url));
const page = fileURLToPath(new URL('./driver.ts', import.meta.url));

/** The built page's Content-Security-Policy: its own scripts and the
 * wasm compiled from them, and requests to any https or wss server, since
 * the buyer picks the Esplora and Nexus they trust. 'self' in connect-src
 * lets the page fetch its own wasm when served over http locally. Build
 * only: the dev server's inline HMR client and ws: would be refused. */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "connect-src 'self' https: wss:",
].join('; ');

export default defineConfig(({ mode }) => ({
  // Relative, so the build serves from any path of its own origin.
  base: './',
  // public/ holds the mainnet Pages site's CNAME (swap.lattice.build): the
  // signet build is for another origin and carries none.
  publicDir: mode === 'signet' ? false : 'public',
  plugins: [
    preact(),
    {
      name: 'csp',
      apply: 'build',
      transformIndexHtml: () => [
        { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
      ],
    },
  ],
  resolve: {
    alias: [
      { find: /^lattice-swap-driver$/, replacement: page },
      { find: /^lattice-swap-driver\/(.*)$/, replacement: `${driver}$1` },
    ],
  },
  build: { target: 'es2022' },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    // The driver and its fakes as Node loads them, one module instance for
    // the page and the fakes: transformed for jsdom, the fakes' `new URL(...,
    // import.meta.url)` file reads would be rewritten to the page's origin.
    server: { deps: { external: [/vendor\/lattice-swap\/web\/driver\//] } },
    testTimeout: 60_000,
  },
}));
