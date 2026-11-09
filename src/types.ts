// The shapes the driver hands the page, as its doc comments give them:
// `Buyer#status()` in driver.js, and an offer as swap-wasm's `decodeOffer`
// reads one from a relay's board.

export type Step = 'fund-wallet' | 'swapping' | 'finishing' | 'asking' | 'received' | 'done' | 'refunding' | 'refunded' | 'offer-gone' | 'cancelled';
export type Outcome = 'swapped' | 'refunded' | 'punished' | 'drained' | 'aborted';

export interface Deadline {
  height: number;
  /** ms since the epoch */
  eta: number;
}

export interface Status {
  swapId: string;
  step: Step;
  outcome: Outcome | null;
  wallet: { address: string; confirmed: number | null; unconfirmed: number | null };
  need: number | null;
  confirmations: {
    funding: number | null;
    lockSpend: number | null;
    cancelSpend: number | null;
    nexLock: number | null;
  };
  deadlines: {
    cancel: Deadline | null;
    refund: { from: number; until: number } | null;
    punish: Deadline | null;
  };
  mustStayOpen: boolean;
  backupCovers: 'wallet' | 'lock';
  /** Taken its offer and not ended: no other swap, and no withdrawal. */
  running: boolean;
  /** The swap's terms: sat, sat a NEX, and NEX base units: `nex_amount`
   * is what the seller locks, and the claim pays `nex_fee` of it, so the
   * buyer receives `nex_amount - nex_fee`. */
  btc_amount: number;
  price: number;
  nex_amount: number;
  nex_fee: number;
  /** How deep each lock must be. */
  btc_confirmations: number;
  nex_confirmations: number;
  /** Where the NEX goes; null for a swap recorded before it was kept. */
  nexAddress: string | null;
  tip: number | null;
  warning: string | null;
}

export interface Offer {
  quote: { price: number; min_btc_amount: number; max_btc_amount: number };
  template: {
    swap_id: string;
    btc_fee: number;
    nex_fee: number;
    t1: number;
    t2: number;
    btc_confirmations: number;
    nex_confirmations: number;
    margin: number;
    nexus_genesis: string;
  };
  btc_network: string;
  relay: string | null;
  seller: string;
}

/** An offer on the board: its text, which `Buyer.prepare` takes, and what
 * it says. */
export interface Listed {
  text: string;
  offer: Offer;
}

export interface Balance {
  confirmed: number | null;
  unconfirmed: number | null;
}
