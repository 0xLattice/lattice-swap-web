// The relay directory: relays found on a chain, beside the buyer's own.
// The tip read from is the hosting node's word, so the list can hide relays
// or name useless ones, but never move funds: an offer is its seller's,
// and listed only on the relay it names.

import { giveRelayNode, listRelays, type RelayListing } from 'lattice-swap-driver';
import { sameServer, type Directory } from './config';
import { capped } from './offers';

/** The most relays found on the directory whose offers are read: each is
 * a request on every refresh, and a directory could list without end. */
export const MAX_DIRECTORY_RELAYS = 16;

/** How long a read of the directory may take, in all, in ms. */
export const DIRECTORY_TIMEOUT = 15_000;

/** How long after a failed read the directory is read again, in ms. */
export const DIRECTORY_RETRY = 60_000;

/** The most nodes asked for in one request: lattice-node's bound on a
 * many-Volume read (`maximumCompleteVolumeRecordsRoots`). */
export const MAX_BATCH = 32;

/** The most bytes of one answer of the directory's node read: lattice-node
 * keeps a many-Volume answer within one protocol frame, 4 MiB. */
export const MAX_DIRECTORY_BYTES = 4 << 20;

/** How long to wait on a node that answers 429, as a public read port
 * does past its burst of Volume reads: it refills one a second. */
const RATE_WAIT = 1_000;

type Fetch = typeof globalThis.fetch;
const pageFetch: Fetch = (...args) => globalThis.fetch(...args);

/** The frames of `data` from `at` on, big-endian: each a `u16`-long name
 * and `u32`-long bytes; `count` of them, or to the end. */
function frames(data: Uint8Array, at: number, count = Infinity): Map<string, Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  /** Where the next `n` bytes start, once there are that many. */
  const skip = (n: number) => {
    if (at + n > data.length) throw new Error('a Volume answer cut short');
    at += n;
    return at - n;
  };
  const found = new Map<string, Uint8Array>();
  for (let i = 0; i < count && at < data.length; i++) {
    const name = new TextDecoder().decode(data.subarray(skip(view.getUint16(skip(2))), at));
    found.set(name, data.subarray(skip(view.getUint32(skip(4))), at));
  }
  return found;
}

/** The node `cid` names out of `archive`, a Volume rooted at it as
 * lattice-node frames one: a `u16` count of nodes, then each node's frame.
 * The others are left unread: the listing asks for each node it reads. */
export function rootOf(archive: Uint8Array, cid: string): Uint8Array {
  if (archive.length < 2) throw new Error('a Volume answer cut short');
  const root = frames(archive, 2, (archive[0] << 8) | archive[1]).get(cid);
  if (root === undefined) throw new Error(`the node's Volume ${cid} lacks its root`);
  return root;
}

/** What a read of the directory found: the URLs of the relays it lists,
 * and why the list is only part of it, if it is. */
export interface DirectoryRead {
  relays: string[];
  partial: string | null;
}

/** The relays the directory's chain lists at its tip, as its node reports
 * the tip, each node of the list read from the node's Volumes, up to
 * MAX_BATCH at a time, and given to swap-wasm, which checks it against its
 * CID, in the order the listing wants them: depth-first, which its bound
 * on nodes read counts on. Refuses an answer for another chain. A read cut
 * short, by an error or after `timeout` ms, keeps the relays listed by
 * then, as partial; it fails if none were. */
export async function readDirectory({ node, chain }: Directory, fetch: Fetch = pageFetch, timeout = DIRECTORY_TIMEOUT): Promise<DirectoryRead> {
  const base = node.trim().replace(/\/+$/, '');
  const signal = AbortSignal.timeout(timeout);
  const pause = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, RATE_WAIT);
      signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
    });
  /** The body of the answer to `route` on the directory's chain, asked
   * again after a pause while the node says too many. No redirects, as the
   * driver's clients follow none. */
  async function get(route: string): Promise<Uint8Array> {
    const url = `${base}${route}${route.includes('?') ? '&' : '?'}chainPath=${encodeURIComponent(chain)}`;
    try {
      for (;;) {
        const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal });
        if (response.status === 429) {
          await response.body?.cancel();
          await pause();
          continue;
        }
        if (!response.ok) throw new Error(`${base}${route.replace(/\?.*/, '')}: ${response.status}`);
        return await capped(response, MAX_DIRECTORY_BYTES);
      }
    } catch (e) {
      if (signal.aborted) throw new Error(`${base}: no answer within ${timeout} ms`);
      throw e;
    }
  }
  const info = JSON.parse(new TextDecoder().decode(await get('/api/chain/info')));
  if (JSON.stringify(info.chain) !== JSON.stringify(chain.split('/'))) {
    throw new Error(`the node answered for another chain than ${chain}`);
  }
  if (typeof info.tipCID !== 'string') throw new Error(`${chain} has no tip yet`);
  // swap-wasm throws its reasons as strings.
  const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let listing: RelayListing;
  try {
    listing = listRelays(info.tipCID);
  } catch (e) {
    throw new Error(reason(e));
  }
  /** Nodes read and not yet given, by CID. */
  const held = new Map<string, Uint8Array>();
  /** The listing given every node read as soon as it is read, in whatever
   * order: what it wants is what to ask for next, a level of the trie a
   * request rather than a node. Only `listing`, given each node in the
   * order it wants them, is the list. */
  let ahead = listing;
  try {
    while (listing.wants.length > 0) {
      const [next] = listing.wants;
      if (!held.has(next)) {
        const read = () => ahead.wants.find((cid) => held.has(cid));
        for (let cid = read(); cid !== undefined; cid = read()) ahead = giveRelayNode(ahead, cid, held.get(cid)!);
        const batch = [next, ...ahead.wants.filter((cid) => cid !== next && !held.has(cid))].slice(0, MAX_BATCH);
        for (const [cid, archive] of frames(await get(`/volumes?cids=${batch.join(',')}`), 0)) {
          if (batch.includes(cid)) held.set(cid, rootOf(archive, cid));
        }
        // One the node left out of the batch is asked for on its own.
        if (!held.has(next)) held.set(next, rootOf(await get(`/volumes/${next}`), next));
      }
      listing = giveRelayNode(listing, next, held.get(next)!);
      held.delete(next);
    }
    return { relays: listing.relays.map((relay) => relay.url), partial: null };
  } catch (e) {
    if (listing.relays.length === 0) throw new Error(reason(e));
    return { relays: listing.relays.map((relay) => relay.url), partial: reason(e) };
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
