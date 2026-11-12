import { decodeOffer, offers, safe } from 'lattice-swap-driver';
import { sameServer } from './config';
import type { Listed, Offer } from './types';

/** The most entries of one relay's list that are read: each is a
 * signature to check, and a relay could list without end. */
export const MAX_OFFERS = 100;

/** The most bytes of the list of a relay of the buyer's own read: a relay
 * holds up to 10,000 offers of 1 to 4 KiB, and the list is parsed whole
 * before its first MAX_OFFERS are read, so a busy honest relay's is read
 * in full. */
export const MAX_OWN_RELAY_BYTES = 48 << 20;

/** The most bytes of the list of a relay found on a directory read: any
 * host a directory names, up to MAX_DIRECTORY_RELAYS of them, so each is
 * held to a thousand offers or so, ten times MAX_OFFERS. */
export const MAX_FOUND_RELAY_BYTES = 4 << 20;

/** The body of `response`, read as it streams; refused past `max` bytes,
 * the rest left unread. */
export async function capped(response: Response, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  for (;;) {
    const read = await reader?.read();
    if (read === undefined || read.done) break;
    size += read.value.length;
    if (size > max) {
      await reader!.cancel();
      throw new Error(`an answer over ${max} bytes`);
    }
    chunks.push(read.value);
  }
  const body = new Uint8Array(size);
  chunks.reduce((at, chunk) => (body.set(chunk, at), at + chunk.length), 0);
  return body;
}

/** The page's fetch, each answer's body read by `capped` at `max` bytes. */
const cappedFetch =
  (max: number): typeof fetch =>
  async (input, init) => {
    const response = await globalThis.fetch(input, init);
    return new Response(await capped(response, max), { status: response.status, statusText: response.statusText, headers: response.headers });
  };

/** Cheapest NEX first. */
export const byPrice = (a: Listed, b: Listed) => a.offer.quote.price - b.offer.quote.price;

/** The offers `relay` lists for `network` and the Nexus of `genesis`,
 * cheapest NEX first, its list read up to `max` bytes. Left out: an offer `decodeOffer` refuses, one with an
 * amount JavaScript cannot hold exactly (above 2^53), which the driver
 * refuses too, any past the first MAX_OFFERS, one at a price of 0, whose NEX no swap can pay, and one
 * that names another relay: the swap runs through the relay the offer
 * names, which its seller does not sign, so `relay` could send the buyer
 * to one the buyer never chose. */
export async function listOffers(relay: string, network: string, genesis: string, max = MAX_OWN_RELAY_BYTES): Promise<Listed[]> {
  const listed: Listed[] = [];
  for (const text of (await offers(relay, cappedFetch(max))).slice(0, MAX_OFFERS)) {
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
