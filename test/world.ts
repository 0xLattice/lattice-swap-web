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
import type { AppConfig } from '../src/config';

export { call, parseTx, POLICY };

const servers: { close: () => void }[] = [];
export const closeServers = () => servers.splice(0).forEach((server) => server.close());

/** The test policy's bounds: the test offer's short timelocks are below
 * the CLI's defaults. */
const BOUNDS = Object.fromEntries(Object.entries(POLICY).filter(([name]) => name !== 'btc_amount' && name !== 'price'));

export async function world({ relay = true, store = new MemoryStore(), extra = {} as Record<string, unknown> } = {}) {
  const chain = new Chain();
  const a = await esplora(chain);
  const node = await nexus();
  const offer = testOffer('http://relay.invalid');
  const board = await serve((_method: string, path: string) => (path === '/offers' ? [200, [JSON.parse(offer)]] : undefined));
  servers.push(a, node, board);
  const w = {
    chain,
    a,
    store,
    offer,
    seller: seller(offer),
    nexAddress: call('newNexKey').address as string,
    config: undefined as unknown as AppConfig,
  };
  w.config = {
    network: 'regtest',
    esplora: a.url,
    nexus: node.url,
    nexusGenesis: 'genesis',
    relay: relay ? board.url : null,
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
