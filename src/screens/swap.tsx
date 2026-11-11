import { useState } from 'preact/hooks';
import { isCid } from 'lattice-swap-driver';
import type { OffersState } from '../app';
import { costs } from '../costs';
import { bounded, btc, host, nex, parseBtc, refundAfter } from '../format';
import type { Balance, Listed } from '../types';
import { Row } from './ui';

/** Selfhold, the Lattice wallet extension, gives pages `window.lattice`. */
type Selfhold = { isLatticeWallet?: boolean; connect: () => Promise<string> };
const selfhold = () => {
  const wallet = (window as { lattice?: Selfhold }).lattice;
  return wallet?.isLatticeWallet ? wallet : null;
};

export function NoRelay() {
  return (
    <div role="status" class="box strong-border">
      <span class="strong">No relay configured</span>
      <span class="small muted">No offers are listed: add a swap relay to read them from in Settings.</span>
    </div>
  );
}

/** Each relay whose offers could not be read: the others' are listed. */
export function RelayFailures({ failed }: { failed: Record<string, string> }) {
  return (
    <>
      {Object.entries(failed).map(([relay, error]) => (
        <p key={relay} role="alert" class="error">
          Could not read the offers of {host(relay)}: {bounded(error)}
        </p>
      ))}
    </>
  );
}

export function SwapForm(props: {
  relays: string[];
  offers: OffersState;
  offer: Listed | null;
  /** The offer picked is no longer listed: the buyer picks again. */
  pickGone: boolean;
  onRepick: () => void;
  amount: string;
  setAmount: (value: string) => void;
  nexAddress: string;
  setNexAddress: (value: string) => void;
  balance: Balance | null;
  onWallet: () => void;
  onReview: () => Promise<void>;
}) {
  const { offer, offers, amount, nexAddress, balance } = props;
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sats = parseBtc(amount);
  const quote = offer?.offer.quote;
  const inRange = sats !== null && quote !== undefined && sats >= quote.min_btc_amount && sats <= quote.max_btc_amount;
  const address = nexAddress.trim();
  const validAddress = address !== '' && isCid(address);
  return (
    <section class="narrow">
      {props.relays.length === 0 && <NoRelay />}
      <RelayFailures failed={offers.failed} />
      {props.pickGone && (
        <div role="alert" class="box strong-border">
          <span class="strong">The offer you picked is gone</span>
          <span class="small muted">Its seller took it off the relay. Pick another to see its price.</span>
          <button type="button" class="primary" onClick={props.onRepick}>
            Pick another offer
          </button>
        </div>
      )}
      {props.relays.length > 0 && offers.loaded && Object.keys(offers.failed).length === 0 && !props.pickGone && offer === null && (
        <div role="status" class="box">
          No offers on the relays right now.
        </div>
      )}
      <div class="card">
        <div class="field">
          <label for="pay" class="label">
            You pay
          </label>
          <div class="amount">
            <input
              id="pay"
              inputMode="decimal"
              autocomplete="off"
              placeholder={quote ? btc(quote.min_btc_amount) : '0.00000000'}
              value={amount}
              onInput={(e) => props.setAmount(e.currentTarget.value)}
            />
            <span class="unit">BTC</span>
          </div>
          {balance?.confirmed != null && (
            <button type="button" class="link small muted" onClick={props.onWallet}>
              In your wallet: {btc(balance.confirmed)} BTC
            </button>
          )}
          {quote && amount.trim() !== '' && !inRange && (
            <span class="small error">
              Pay between {btc(quote.min_btc_amount)} and {btc(quote.max_btc_amount)} BTC
            </span>
          )}
        </div>
        <div class="field">
          <span class="label">You get</span>
          <div class="amount">
            <span class="big" data-testid="quote">
              {offer && inRange ? nex(costs(offer.offer, sats!, null).receive) : '0'}
            </span>
            <span class="unit">NEX</span>
          </div>
          {offer && (
            <button type="button" class="link small muted" aria-expanded={details} onClick={() => setDetails(!details)}>
              1 NEX = {btc(offer.offer.quote.price)} BTC ·{' '}
              {offer === offers.list[0] ? `best of ${offers.list.length}` : 'your pick'} {details ? '▴' : '▾'}
            </button>
          )}
          {offer && details && (
            <div class="details">
              <Row label="You can pay">
                {btc(offer.offer.quote.min_btc_amount)} – {btc(offer.offer.quote.max_btc_amount)} BTC
              </Row>
              <Row label="If it doesn’t finish">BTC back in {refundAfter(offer.offer)} with this page open</Row>
              <Row label="Relay">
                <span class="small muted">{host(offer.relay)}</span>
              </Row>
            </div>
          )}
        </div>
        <div class="field">
          <label for="to" class="label">
            Send NEX to
          </label>
          <input
            id="to"
            class="text"
            placeholder="Your Nexus address"
            autocomplete="off"
            value={nexAddress}
            onInput={(e) => props.setNexAddress(e.currentTarget.value)}
          />
          {address !== '' && !validAddress && <span class="small error">Not a Nexus address</span>}
          {selfhold() !== null && (
            <button
              type="button"
              class="link small muted"
              onClick={() =>
                selfhold()!
                  .connect()
                  .then(props.setNexAddress, (e: Error) => setError(e.message))
              }
            >
              Use my Selfhold address
            </button>
          )}
        </div>
      </div>
      {error !== null && (
        <p role="alert" class="error">
          {bounded(error)}
        </p>
      )}
      <button
        type="button"
        class="primary big-button"
        disabled={!inRange || !validAddress}
        onClick={() => props.onReview().catch((e: Error) => setError(e.message))}
      >
        Swap
      </button>
      <p class="small muted">Peer to peer. Your wallet key stays in this browser.</p>
    </section>
  );
}
