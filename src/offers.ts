import { decodeOffer, offers, safe } from 'lattice-swap-driver';
import { sameServer } from './config';
import type { Listed, Offer } from './types';

/** Cheapest NEX first. */
export const byPrice = (a: Listed, b: Listed) => a.offer.quote.price - b.offer.quote.price;

/** The offers `relay` lists for `network` and the Nexus of `genesis`,
 * cheapest NEX first. Left out: an offer `decodeOffer` refuses, one with an
 * amount JavaScript cannot hold exactly (above 2^53), which the driver
 * refuses too, one at a price of 0, whose NEX no swap can pay, and one
 * that names another relay: the swap runs through the relay the offer
 * names, which its seller does not sign, so `relay` could send the buyer
 * to one the buyer never chose. */
export async function listOffers(relay: string, network: string, genesis: string): Promise<Listed[]> {
  const listed: Listed[] = [];
  for (const text of await offers(relay)) {
    let offer: Offer;
    try {
      offer = decodeOffer(text);
    } catch {
      continue;
    }
    if (!safe(offer) || offer.quote.price === 0) continue;
    if (!offer.relay || !sameServer(offer.relay, relay)) continue;
    if (offer.btc_network === network && offer.template.nexus_genesis === genesis) listed.push({ text, offer, relay });
  }
  return listed.sort(byPrice);
}

/** The offer a swap would take from `list`: the one picked, by its text,
 * else the best. A pick no longer listed is `gone`, with no offer: the
 * buyer picks again rather than being moved to another seller's terms. */
export function offerFor(list: Listed[], chosen: string | null): { offer: Listed | null; gone: boolean } {
  if (chosen === null) return { offer: list[0] ?? null, gone: false };
  const offer = list.find((listed) => listed.text === chosen) ?? null;
  return { offer, gone: offer === null };
}
