import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// The driver, from the lattice-swap submodule pinned in vendor/.
const driver = fileURLToPath(new URL('./vendor/lattice-swap/web/driver/src/', import.meta.url));

export default defineConfig({
  // Relative, so one build serves from any path: Pages' /lattice-swap-web/,
  // or its /signet/ beside it.
  base: './',
  plugins: [preact()],
  resolve: {
    alias: [
      { find: /^lattice-swap-driver$/, replacement: `${driver}index.js` },
      { find: /^lattice-swap-driver\/(.*)$/, replacement: `${driver}$1` },
    ],
  },
  build: { target: 'es2022' },
  test: {
    environment: 'jsdom',
    testTimeout: 60_000,
  },
});
