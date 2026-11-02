import { offers } from 'lattice-swap-driver';
import { call } from 'lattice-swap-driver/wasm.js';
import type { Listed, Offer } from './types';

/** The offers `relay` lists for `network` and the Nexus of `genesis`,
 * cheapest NEX first. An offer `decodeOffer` refuses is left out. */
export async function listOffers(relay: string, network: string, genesis: string): Promise<Listed[]> {
  const listed: Listed[] = [];
  for (const text of await offers(relay)) {
    let offer: Offer;
    try {
      offer = call('decodeOffer', text);
    } catch {
      continue;
    }
    if (offer.btc_network === network && offer.template.nexus_genesis === genesis) listed.push({ text, offer });
  }
  return listed.sort((a, b) => a.offer.quote.price - b.offer.quote.price);
}

/** The offer a swap would take from `list`: the one picked, by its text,
 * else the best. A pick no longer listed is `gone`, with no offer: the
 * buyer picks again rather than being moved to another seller's terms. */
export function offerFor(list: Listed[], chosen: string | null): { offer: Listed | null; gone: boolean } {
  if (chosen === null) return { offer: list[0] ?? null, gone: false };
  const offer = list.find((listed) => listed.text === chosen) ?? null;
  return { offer, gone: offer === null };
}
