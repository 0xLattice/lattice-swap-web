// The driver as the page imports it, `lattice-swap-driver`: the pinned
// driver's own exports, and the swap-wasm calls the page makes itself. One
// module, so a host embedding the page can alias it to its own.

import { call, safe, wasm } from './vendor/lattice-swap/web/driver/src/wasm.js';
import type { Offer } from './src/types';

export * from './vendor/lattice-swap/web/driver/src/index.js';
export { safe };

/** The offer `text` says, as swap-wasm's `decodeOffer` reads it; throws on
 * one it refuses. */
export const decodeOffer = (text: string): Offer => call('decodeOffer', text);

/** Whether `address` is a Nexus address. */
export const isCid = (address: string): boolean => wasm.isCid(address);
