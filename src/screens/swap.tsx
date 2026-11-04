import { useState } from 'preact/hooks';
import { isCid } from 'lattice-swap-driver';
import type { OffersState } from '../app';
import { bounded, btc, nex, nexFor, parseBtc, refundAfter } from '../format';
import type { Balance, Listed } from '../types';
import { Row } from './ui';

export function NoRelay() {
  return (
    <div role="status" class="box strong-border">
      <span class="strong">No relay configured</span>
      <span class="small muted">This build lists no offers: it names no swap relay to read them from.</span>
    </div>
  );
}

export function SwapForm(props: {
  relay: string | null;
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
      {props.relay === null && <NoRelay />}
      {props.relay !== null && offers.error !== null && (
        <p role="alert" class="error">
          Could not read the relay's offers: {bounded(offers.error)}
        </p>
      )}
      {props.pickGone && (
        <div role="alert" class="box strong-border">
          <span class="strong">The offer you picked is gone</span>
          <span class="small muted">Its seller took it off the relay. Pick another to see its price.</span>
          <button type="button" class="primary" onClick={props.onRepick}>
            Pick another offer
          </button>
        </div>
      )}
      {props.relay !== null && offers.loaded && offers.error === null && !props.pickGone && offer === null && (
        <div role="status" class="box">
          No offers on the relay right now.
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
              {quote && inRange ? nex(nexFor(sats!, quote.price)) : '0'}
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
