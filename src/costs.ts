// What a swap costs the buyer, as the engine charges it (lattice-swap):
//
// - The lock's own Bitcoin fee, from the buyer's wallet: what `Wallet.need`
//   asks above the amount.
// - The claim's Nexus fee, `nex_fee`, from the NEX: the claim moves the
//   lock's `nex_amount` less `nex_fee` to the buyer.
// - Redeem's two `btc_fee` come out of the seller's payout, and the NEX
//   lock's `nex_fee` out of the seller's wallet: neither is the buyer's.
// - If the swap fails, cancel and refund each pay `btc_fee` from the
//   locked amount: the buyer gets `btc_amount - 2 * btc_fee` back, and the
//   lock fee stays spent.

import { nexFor } from './format';
import type { Offer } from './types';

const BASE = 1_000_000;

export interface Costs {
  /** The amount locked, sat. */
  amount: number;
  /** The lock's Bitcoin fee, sat; null while unknown. */
  lockFee: number | null;
  /** All that leaves the wallet, sat: the amount and the lock fee. */
  pay: number;
  /** The claim's Nexus fee, base units, and about what it is worth in sat
   * at the offer's price. */
  claimFee: number;
  claimFeeSats: number;
  /** The NEX that reaches the buyer, base units: the seller's lock less
   * the claim fee. */
  receive: bigint;
  /** The offer's price and the one paid with every fee, sat a NEX; null
   * if no NEX arrives. */
  price: number;
  effective: number | null;
  /** The share of `pay` that buys no NEX at the offer's price, 0 to 1. */
  feeShare: number;
  /** If the swap fails: what cancel and refund pay, and the sat back. */
  refundFees: number;
  refunded: number;
}

/** The NEX that reaches the buyer, base units: the seller's lock,
 * `nexAmount`, less the claim's `nexFee`; none if the fee takes it all. */
export function received(nexAmount: number | bigint, nexFee: number): bigint {
  const locked = BigInt(nexAmount);
  return locked > BigInt(nexFee) ? locked - BigInt(nexFee) : 0n;
}

export function costs(offer: Offer, amount: number, lockFee: number | null): Costs {
  const { price } = offer.quote;
  const { btc_fee, nex_fee } = offer.template;
  const receive = received(nexFor(amount, price), nex_fee);
  const pay = amount + (lockFee ?? 0);
  const worth = (Number(receive) * price) / BASE;
  const refundFees = 2 * btc_fee;
  return {
    amount,
    lockFee,
    pay,
    claimFee: nex_fee,
    claimFeeSats: (nex_fee * price) / BASE,
    receive,
    price,
    effective: receive === 0n ? null : (pay * BASE) / Number(receive),
    feeShare: 1 - worth / pay,
    refundFees,
    refunded: Math.max(0, amount - refundFees),
  };
}

/** `value` sat, rounded, with thousands separators; "<1 sat" for a
 * fraction that would round to none. */
export function sat(value: number): string {
  if (value > 0 && value < 0.5) return '<1 sat';
  return `${Math.round(value).toLocaleString('en-US')} sat`;
}

/** `share` as a percent: one decimal below 10%, none above; "<0.1%" for
 * a share that would round to none. */
export function percent(share: number): string {
  const p = share * 100;
  if (p > 0 && p < 0.05) return '<0.1%';
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

/** `text`, an estimate, marked as one: "<…" says so already. */
export const about = (text: string) => (text.startsWith('<') ? text : `~${text}`);
