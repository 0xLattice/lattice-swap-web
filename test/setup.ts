import { URL as NodeURL } from 'node:url';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { cleanup } from '@testing-library/preact';
import { loadWasm } from '../vendor/lattice-swap/web/driver/test/fakes.js';
import { closeServers } from './world';

// Node's URL over jsdom's: the fakes read their files through `new URL(...,
// import.meta.url)`, which Node's fs takes only as its own.
globalThis.URL = NodeURL as unknown as typeof URL;

beforeAll(async () => {
  await loadWasm();
  // jsdom has no object URLs: a download is a click on a link to one.
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
  // Nor `Blob#text`, which a browser reads a chosen file with.
  Blob.prototype.text ??= function (this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
});
// Unmounting the page aborts its swap's run.
afterEach(cleanup);
afterAll(closeServers);
