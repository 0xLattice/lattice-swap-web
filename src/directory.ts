// The relay directory: relays found on a chain, beside the buyer's own.
// The tip read from is the hosting node's word, so the list can hide relays
// or name useless ones, but never move funds: an offer is its seller's,
// and listed only on the relay it names.

import { giveRelayNode, listRelays } from 'lattice-swap-driver';
import { sameServer, type Directory } from './config';

/** The most relays found on the directory whose offers are read: each is
 * a request on every refresh, and a directory could list without end. */
export const MAX_DIRECTORY_RELAYS = 16;

/** How long a read of the directory may take, in all, in ms. */
export const DIRECTORY_TIMEOUT = 15_000;

type Fetch = typeof globalThis.fetch;
const pageFetch: Fetch = (...args) => globalThis.fetch(...args);

/** The node `cid` names out of `archive`, a Volume rooted at it as
 * lattice-node frames one, big-endian: a `u16` count of nodes, then each
 * node's `u16` CID length, CID, `u32` length and bytes. The others are left
 * unread: the listing asks for each node it reads. */
export function rootOf(archive: Uint8Array, cid: string): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let at = 0;
  /** Where the next `n` bytes start, once there are that many. */
  const skip = (n: number) => {
    if (at + n > archive.length) throw new Error('a Volume archive cut short');
    at += n;
    return at - n;
  };
  const count = view.getUint16(skip(2));
  for (let i = 0; i < count; i++) {
    const name = new TextDecoder().decode(archive.subarray(skip(view.getUint16(skip(2))), at));
    const bytes = archive.subarray(skip(view.getUint32(skip(4))), at);
    if (name === cid) return bytes;
  }
  throw new Error(`the node's Volume ${cid} lacks its root`);
}

/** The URLs of the relays the directory's chain lists at its tip, as its
 * node reports the tip, each node of the list read from the node's Volumes
 * and checked against its CID by swap-wasm, in the order the listing
 * wants them: depth-first, which its bound on nodes read counts on. Refuses
 * an answer for another chain; gives up after `timeout` ms. */
export async function readDirectory({ node, chain }: Directory, fetch: Fetch = pageFetch, timeout = DIRECTORY_TIMEOUT): Promise<string[]> {
  const base = node.trim().replace(/\/+$/, '');
  const signal = AbortSignal.timeout(timeout);
  /** `read` of the answer to `route` on the directory's chain. No
   * redirects, as the driver's clients follow none. */
  async function get<T>(route: string, read: (response: Response) => Promise<T>): Promise<T> {
    const url = `${base}${route}?chainPath=${encodeURIComponent(chain)}`;
    try {
      const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal });
      if (!response.ok) throw new Error(`${base}${route}: ${response.status}`);
      return await read(response);
    } catch (e) {
      if (signal.aborted) throw new Error(`${base}: no answer within ${timeout} ms`);
      throw e;
    }
  }
  const info = await get('/api/chain/info', (response) => response.json());
  if (JSON.stringify(info.chain) !== JSON.stringify(chain.split('/'))) {
    throw new Error(`the node answered for another chain than ${chain}`);
  }
  if (typeof info.tipCID !== 'string') throw new Error(`${chain} has no tip yet`);
  try {
    let listing = listRelays(info.tipCID);
    while (listing.wants.length > 0) {
      const cid = listing.wants[0];
      const archive = await get(`/volumes/${encodeURIComponent(cid)}`, async (response) => new Uint8Array(await response.arrayBuffer()));
      listing = giveRelayNode(listing, cid, rootOf(archive, cid));
    }
    return listing.relays.map((relay) => relay.url);
  } catch (e) {
    // swap-wasm throws its reasons as strings.
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** The relays of `found` whose offers are read beside `own`'s: those not
 * among `own`, each server once, at most MAX_DIRECTORY_RELAYS of them,
 * picked at random. */
export function pickFound(own: string[], found: string[]): string[] {
  const picked: string[] = [];
  for (const url of found) {
    if (![...own, ...picked].some((kept) => sameServer(kept, url))) picked.push(url);
  }
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  return picked.slice(0, MAX_DIRECTORY_RELAYS);
}
