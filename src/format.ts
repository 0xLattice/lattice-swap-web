// Amounts and times as the page shows them. A NEX is 1,000,000 base units;
// a price is in sat a NEX.

import type { Offer } from './types';

const SAT = 100_000_000n;
const BASE = 1_000_000n;
/** About ten minutes a Bitcoin block, as the driver times its deadlines. */
const BLOCK_MS = 600_000;

function decimal(value: bigint, unit: bigint, places: number): string {
  const whole = value / unit;
  const frac = (value % unit).toString().padStart(places, '0');
  return `${whole}.${frac}`;
}

/** `sats` as BTC, all eight places. */
export function btc(sats: number): string {
  return decimal(BigInt(sats), SAT, 8);
}

/** `base` units as NEX, trailing zeros dropped. */
export function nex(base: number | bigint): string {
  return decimal(BigInt(base), BASE, 6).replace(/\.?0+$/, '');
}

/** A BTC amount typed in, as sat; null if it is not one. */
export function parseBtc(text: string): number | null {
  const m = text.trim().match(/^(\d*)(?:\.(\d{0,8}))?$/);
  if (!m || (m[1] === '' && !m[2])) return null;
  const sats = BigInt(m[1] || '0') * SAT + BigInt((m[2] ?? '').padEnd(8, '0'));
  return sats <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sats) : null;
}

/** The base units `sats` buys at `price`, rounded down, as the driver's
 * `prepare` says. */
export function nexFor(sats: number, price: number): bigint {
  return (BigInt(sats) * BASE) / BigInt(price);
}

/** Roughly how long `ms` is. */
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `~${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `~${hours} hours`;
  return `~${Math.round(hours / 24)} days`;
}

/** How long until the BTC is back if the seller vanishes, with the page
 * open for the refund: the lock in a block, cancel `t1` blocks after it,
 * the refund once cancel is `btc_confirmations` deep, and the refund that
 * deep in turn. */
export function refundAfter(offer: Offer): string {
  const { t1, btc_confirmations } = offer.template;
  return duration((1 + t1 + 2 * btc_confirmations) * BLOCK_MS);
}

/** What a server or the driver said, cut to a length a page can show. */
export function bounded(text: string, max = 240): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function when(eta: number): string {
  return new Date(eta).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
