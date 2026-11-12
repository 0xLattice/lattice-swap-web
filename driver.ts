// The driver as the page imports it, `lattice-swap-driver`: the pinned
// driver's own exports, and the swap-wasm calls the page makes itself. One
// module, so a host embedding the page can alias it to its own.

import { call, safe, wasm } from './vendor/lattice-swap/web/driver/src/wasm.js';
import { Esplora } from './vendor/lattice-swap/web/driver/src/esplora.js';
import { checkNexus, Nexus } from './vendor/lattice-swap/web/driver/src/views.js';
import type { Offer } from './src/types';

export * from './vendor/lattice-swap/web/driver/src/index.js';
export { safe };

/** The offer `text` says, as swap-wasm's `decodeOffer` reads it; throws on
 * one it refuses. */
export const decodeOffer = (text: string): Offer => call('decodeOffer', text);

/** A relay directory listing under way, as swap-wasm's `listRelays` and
 * `giveRelayNode` give it: the CIDs of the nodes it still `wants`, the
 * next first, and the `relays` read so far, all of them once it wants
 * none. */
export interface RelayListing {
  state: unknown;
  wants: string[];
  relays: { account: string; url: string }[];
}

/** A listing of the relays the relay directory lists in the block `block`
 * names. */
export const listRelays = (block: string): RelayListing => call('listRelays', block);

/** `listing` given `bytes` as the node `cid` names; throws on bytes that
 * are not that node's. Called on the wasm itself: `call` would send the
 * bytes as JSON. */
export const giveRelayNode = (listing: RelayListing, cid: string, bytes: Uint8Array): RelayListing =>
  JSON.parse(wasm.giveRelayNode(JSON.stringify(listing.state), cid, bytes));

/** Whether `address` is a Nexus address. */
export const isCid = (address: string): boolean => wasm.isCid(address);

/** `Wallet#check`'s two checks, each of one server before it is used:
 * refuses an Esplora on another network than `network`, and a Nexus node
 * that takes no transactions, follows another Nexus than `genesis`, or
 * keeps no state of past blocks. Either throws if it cannot read the
 * server. The page's fetch, as `Wallet.open` calls it: a browser's
 * refuses to be called as another object's method. */
type Fetch = typeof globalThis.fetch;
const pageFetch: Fetch = (...args) => globalThis.fetch(...args);
export const checkEsplora = (url: string, network: string, fetch: Fetch = pageFetch): Promise<void> =>
  new Esplora(url, fetch).checkNetwork(network);
export const checkNexusNode = (url: string, genesis: string, fetch: Fetch = pageFetch): Promise<void> =>
  checkNexus(new Nexus(url, fetch), genesis);

/** The lock's Bitcoin fee for `amount` sat, priced before any wallet
 * exists: what `Wallet#need` asks above the amount of a wallet with one
 * output to spend, at the rate `Wallet#feeRate` funds at (the Esplora's
 * 6-block estimate, at least 1 sat/vB). */
export async function lockFee(url: string, amount: number, fetch: Fetch = pageFetch): Promise<number> {
  const estimate: number | null = await new Esplora(url, fetch).feeRate(6);
  const rate = Math.max(1, Math.ceil(estimate ?? 1));
  const { need } = call('walletNeed', { utxos: [], amount, fee_rate: rate }) as { need: number };
  return need - amount;
}
