// The page reaches the driver and its wasm only through the one module
// `lattice-swap-driver`, which a host embedding the page aliases to its own.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const SRC = join(import.meta.dirname, '../src');

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [],
  );

test('nothing in src/ imports the driver other than as lattice-swap-driver', () => {
  const imports = sources(SRC).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/\bfrom\s+'([^']+)'|\bimport\s*\(?\s*'([^']+)'/g)].map((m) => `${file}: ${m[1] ?? m[2]}`),
  );
  expect(imports.some((line) => line.endsWith(': lattice-swap-driver'))).toBe(true);
  expect(imports.filter((line) => /lattice-swap-driver\/|wasm|vendor\//.test(line))).toEqual([]);
});
