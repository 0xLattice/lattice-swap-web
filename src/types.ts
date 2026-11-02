// The shapes the driver hands the page, as its doc comments give them:
// `Buyer#status()` in driver.js, and an offer as swap-wasm's `decodeOffer`
// reads one from a relay's board.

export type Step = 'fund-wallet' | 'swapping' | 'finishing' | 'done' | 'refunding' | 'refunded' | 'offer-gone';
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
