// The page against the driver's own fakes (web/driver/test/fakes.js): a
// fake Esplora and Nexus node, a relay listing the test offer, and the
// seller, swap-wasm's machine, standing in for the session.

import { MemoryStore } from 'lattice-swap-driver';
import { call } from 'lattice-swap-driver/wasm.js';
import {
  Chain,
  esplora,
  nexus,
  parseTx,
  POLICY,
  seller,
  serve,
  testOffer,
} from '../vendor/lattice-swap/web/driver/test/fakes.js';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { AppConfig } from '../src/config';

export { call, Chain, esplora, nexus, parseTx, POLICY, serve };

export const servers: { close: () => void }[] = [];
export const closeServers = () => servers.splice(0).forEach((server) => server.close());

/** The test policy's bounds: the test offer's short timelocks are below
 * the CLI's defaults. */
const BOUNDS = Object.fromEntries(Object.entries(POLICY).filter(([name]) => name !== 'btc_amount' && name !== 'price'));

/** A relay listing `listed`, offers as text, read as each is asked for. */
export async function relayOf(listed: string[]) {
  const board = await serve((_method: string, path: string) =>
    path === '/offers' ? [200, listed.map((text) => JSON.parse(text))] : undefined,
  );
  servers.push(board);
  return board;
}

/** `offer` naming `relay`, which its seller does not sign. */
export const naming = (offer: string, relay: string) => JSON.stringify({ ...JSON.parse(offer), relay });

export async function world({ relay = true, store = new MemoryStore(), extra = {} as Record<string, unknown> } = {}) {
  const chain = new Chain();
  const a = await esplora(chain);
  const node = await nexus();
  /** The offers the relay lists, as text: the test offer, naming it. */
  const listed: string[] = [];
  const board = await relayOf(listed);
  const offer = testOffer(board.url);
  listed.push(offer);
  servers.push(a, node);
  const w = {
    chain,
    a,
    store,
    offer,
    listed,
    seller: seller(offer),
    nexAddress: call('newNexKey').address as string,
    config: undefined as unknown as AppConfig,
  };
  w.config = {
    network: 'regtest',
    esplora: a.url,
    nexus: node.url,
    // The test's servers are the build's: public.
    defaults: { esplora: a.url, nexus: node.url, relays: relay ? [board.url] : [] },
    nexusGenesis: 'genesis',
    relays: relay ? [board.url] : [],
    bounds: BOUNDS,
    driver: {
      store,
      locks: null,
      poll: 2,
      openSession: (...args: unknown[]) => w.seller.open(...args),
      ...extra,
    },
  };
  return w;
}

export type World = Awaited<ReturnType<typeof world>>;

/** What the page gives the driver's `Wallet.open`, for the driver used
 * directly beside it: `store` and `locks` as given. */
export function driverOf(w: World, over: Record<string, unknown> = {}) {
  const { network, esplora, nexus, nexusGenesis, driver } = w.config;
  return { network, esplora, nexus, nexusGenesis, ...driver, ...over };
}

/** Pays `value` to `address`, in a block unless `confirmed` is false. */
export function deposit(w: World, address: string, value: number, confirmed = true) {
  w.chain.utxos.set(address, [{ txid: 'aa'.repeat(32), vout: 0, value, height: confirmed ? w.chain.height : null }]);
}

/** `hex` in a block, the chain mined `depth` past it. */
export function confirm(w: World, hex: string, depth = 1) {
  w.chain.txs.set(parseTx(hex).txid, { hex, height: w.chain.height + 1 });
  w.chain.mine(depth);
}

/** The distinct transactions broadcast, in order: the driver broadcasts
 * again while one is unconfirmed. */
export function posted(w: World): string[] {
  return [...new Set<string>(w.a.posted)];
}

/** The test offer with its quote as `quote`, JSON text so an amount above
 * 2^53 survives, signed by a seller of its own as `lattice-swap offer`
 * signs one: the quote, template and network, tagged. */
export function signedOffer(base: string, quote: string): string {
  const offer = JSON.parse(base);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const seller = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex');
  const signed = `["lattice-swap offer 2",${quote},${JSON.stringify(offer.template)},${JSON.stringify(offer.btc_network)}]`;
  const signature = sign(null, Buffer.from(signed), privateKey).toString('hex');
  const rest = JSON.stringify({ ...offer, quote: undefined, seller, signature }).slice(1);
  return `{"quote":${quote},${rest}`;
}

/** `value` as CBOR: text, unsigned integers, arrays, and objects as maps
 * with text keys, as a relay directory's nodes hold them. */
function cbor(value: unknown): number[] {
  const head = (major: number, n: number) =>
    n < 24
      ? [(major << 5) | n]
      : n < 0x100
        ? [(major << 5) | 24, n]
        : n < 0x10000
          ? [(major << 5) | 25, n >> 8, n & 0xff]
          : [(major << 5) | 26, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  if (typeof value === 'number') return head(0, value);
  if (typeof value === 'string') {
    const bytes = [...Buffer.from(value)];
    return [...head(3, bytes.length), ...bytes];
  }
  if (Array.isArray(value)) return [...head(4, value.length), ...value.flatMap(cbor)];
  const entries = Object.entries(value as object);
  return [...head(5, entries.length), ...entries.flatMap(([k, v]) => [...cbor(k), ...cbor(v)])];
}

/** The CID of `bytes` as Lattice spells one: CIDv1 DAG-CBOR SHA-256,
 * base32. */
function cidOf(bytes: Uint8Array): string {
  const binary = [0x01, 0x71, 0x12, 0x20, ...createHash('sha256').update(bytes).digest()];
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let held = 0;
  let out = 'b';
  for (const byte of binary) {
    held = (held << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(held >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + alphabet[(held << (5 - bits)) & 31] : out;
}

/** A relay directory chain's nodes by CID, as a node hosting it serves
 * them, built as cashew's trie files entries (swap::relay_dir's tests). */
export class DirectoryChain {
  nodes = new Map<string, Uint8Array>();
  /** The nodes each node links to, by CID. */
  below = new Map<string, string[]>();

  put(node: object, links: string[] = []): string {
    const bytes = Uint8Array.from(cbor(node));
    const cid = cidOf(bytes);
    this.nodes.set(cid, bytes);
    this.below.set(cid, links);
    return cid;
  }

  /** The children of a node over `entries`, keys relative to it. */
  children(entries: [string, string][]): { children: object[]; links: string[] } {
    const groups = new Map<string, [string, string][]>();
    for (const entry of entries) groups.set(entry[0][0], [...(groups.get(entry[0][0]) ?? []), entry]);
    const links = [...groups.values()].map((group) => this.node(group));
    return { children: [...groups.keys()].map((key, i) => ({ key, value: { rawCID: links[i] } })), links };
  }

  /** The node over `entries`, which share a first character. */
  node(entries: [string, string][]): string {
    let prefix = entries[0][0];
    for (const [key] of entries) while (!key.startsWith(prefix)) prefix = prefix.slice(0, -1);
    const node: Record<string, unknown> = { prefix };
    const rest: [string, string][] = [];
    for (const [key, value] of entries) {
      if (key === prefix) node.value = value;
      else rest.push([key.slice(prefix.length), value]);
    }
    const { children, links } = this.children(rest);
    node.children = children;
    return this.put(node, links);
  }

  /** A block whose general state holds `entries`: the chain's tip. */
  block(entries: [string, string][]): string {
    const { children, links } = this.children(entries);
    const root = this.put({ count: 0, children }, links);
    const state = this.put({ generalState: { rawCID: root } }, [root]);
    return this.put({ postState: { rawCID: state }, height: 1 }, [state]);
  }

  /** The node's answer to `url`, a node hosting the chain `chain` whose
   * tip is `tip`: its chain info, or a Volume holding only the node asked
   * for, each CID asked noted in `asked`. */
  answer(url: string, tip: string, chain = ['Nexus', 'testnet', 'swap-relays'], asked: string[] = []): Response {
    const { pathname } = new URL(url);
    if (pathname === '/api/chain/info') return Response.json({ chain, height: '1', tipCID: tip });
    const cid = decodeURIComponent(pathname.replace(/^\/volumes\//, ''));
    const bytes = this.nodes.get(cid);
    if (bytes === undefined) return new Response('not found', { status: 404 });
    asked.push(cid);
    const name = Buffer.from(cid);
    const archive = Buffer.alloc(2 + 2 + name.length + 4 + bytes.length);
    archive.writeUInt16BE(1, 0);
    archive.writeUInt16BE(name.length, 2);
    name.copy(archive, 4);
    archive.writeUInt32BE(bytes.length, 4 + name.length);
    Buffer.from(bytes).copy(archive, 8 + name.length);
    return new Response(archive);
  }
}
