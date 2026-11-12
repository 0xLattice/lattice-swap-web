// The relay directory: relays found on a chain, beside the buyer's own.
// The tip read from is the hosting node's word, so the list can hide relays
// or name useless ones, but never move funds: an offer is its seller's,
// and listed only on the relay it names.

import { giveRelayNode, isCid, listRelays, type RelayListing } from 'lattice-swap-driver';
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
 * does past its burst of Volume reads: it refills one a second. A 503
 * with Retry-After waits as long as it says. */
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
  const pause = (ms: number) =>
    new Promise((resolve, reject) => {
      const abort = () => (clearTimeout(timer), reject(signal.reason));
      const timer = setTimeout(() => (signal.removeEventListener('abort', abort), resolve(undefined)), ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  /** The body of the answer to `route` on the directory's chain, asked
   * again after a pause while the node says to wait: null for a 404 if
   * `missing` is allowed. No redirects, as the driver's clients follow
   * none. */
  async function get(route: string, missing = false): Promise<Uint8Array | null> {
    const url = `${base}${route}${route.includes('?') ? '&' : '?'}chainPath=${encodeURIComponent(chain)}`;
    try {
      for (;;) {
        const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal });
        const retryAfter = response.headers.get('Retry-After');
        // A 503 waits only when it says to (a browser hides Retry-After
        // cross-origin, where a 503 is a node down); never under a second.
        if (response.status === 429 || (response.status === 503 && retryAfter !== null)) {
          await response.body?.cancel();
          await pause(Math.max(RATE_WAIT, Number(retryAfter) * 1000 || 0));
          continue;
        }
        if (missing && response.status === 404) return null;
        if (!response.ok) throw new Error(`${base}${route.replace(/\?.*/, '')}: ${response.status}`);
        return await capped(response, MAX_DIRECTORY_BYTES);
      }
    } catch (e) {
      if (signal.aborted) throw new Error(`${base}: no answer within ${timeout} ms`);
      throw e;
    }
  }
  const info = JSON.parse(new TextDecoder().decode((await get('/api/chain/info'))!));
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
  /** Nodes read and not yet given to both listings, by CID. */
  const held = new Map<string, Uint8Array>();
  /** The nodes given to `listing`. */
  const given = new Set<string>();
  /** The listing given every node read as soon as it is read, in whatever
   * order: what it wants is what to ask for next, a level of the trie a
   * request rather than a node. Only `listing`, given each node in the
   * order it wants them, is the list. */
  let ahead = listing;
  /** Whether the node reads many Volumes a request: one before lattice-node
   * 1038e320d answers 404, and is asked one at a time. */
  let batches = true;
  /** `archive`'s root, copied out of the answer, which is not kept. */
  const hold = (cid: string, archive: Uint8Array) => held.set(cid, rootOf(archive, cid).slice());
  try {
    while (listing.wants.length > 0) {
      const [next] = listing.wants;
      // A link is the block author's: one that is no CID is never asked.
      if (!isCid(next)) throw new Error(`${next} is not a CID`);
      if (!held.has(next)) {
        const read = () => ahead.wants.find((cid) => held.has(cid));
        for (let cid = read(); cid !== undefined; cid = read()) {
          ahead = giveRelayNode(ahead, cid, held.get(cid)!);
          if (given.has(cid)) held.delete(cid);
        }
        const batch = [next, ...ahead.wants.filter((cid) => cid !== next && !held.has(cid) && isCid(cid))].slice(0, MAX_BATCH);
        const answer: Uint8Array | null = batches ? await get(`/volumes?cids=${batch.map(encodeURIComponent).join(',')}`, true) : null;
        batches = answer !== null;
        for (const [cid, archive] of answer === null ? [] : frames(answer, 0)) {
          if (batch.includes(cid)) hold(cid, archive);
        }
        // One the node left out of the batch is asked for on its own.
        if (!held.has(next)) hold(next, (await get(`/volumes/${encodeURIComponent(next)}`))!);
      }
      listing = giveRelayNode(listing, next, held.get(next)!);
      given.add(next);
      if (!ahead.wants.includes(next)) held.delete(next);
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
