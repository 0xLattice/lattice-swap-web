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
