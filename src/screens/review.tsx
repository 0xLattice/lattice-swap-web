import { useEffect, useState } from 'preact/hooks';
import { about, costs, percent, sat } from '../costs';
import { bounded, btc, nex, refundAfter } from '../format';
import type { Offer } from '../types';
import { Row } from './ui';

export function Review(props: {
  /** The lock's Bitcoin fee for `sats`: from the wallet, or priced
   * without one. */
  lockFee: (sats: number) => Promise<number>;
  offer: Offer;
  sats: number;
  nexAddress: string;
  onStart: () => Promise<void>;
  onBack: () => void;
}) {
  const { offer, sats } = props;
  /** The lock fee: undefined while it is priced, null if it could not be. */
  const [fee, setFee] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    setFee(undefined);
    props.lockFee(sats).then(setFee, () => setFee(null));
  }, [props.lockFee, sats]);
  const c = costs(offer, sats, fee ?? null);
  /** A figure that counts the lock fee: an estimate, '…' while it is
   * priced, and `unpriced` if it could not be. */
  const withFee = (text: string, unpriced: string) =>
    fee === undefined ? '…' : fee === null ? unpriced : about(text);
  const start = () => {
    setStarting(true);
    setError(null);
    props.onStart().catch((e: Error) => {
      setError(e.message);
      setStarting(false);
    });
  };
  return (
    <section class="narrow">
      <h1>Review swap</h1>
      <div class="rows">
        <Row label="You pay" strong>
          {btc(sats)} BTC
        </Row>
        <Row label="You get" strong>
          {nex(c.receive)} NEX
        </Row>
        <Row label="To">
          <code class="break">{props.nexAddress}</code>
        </Row>
      </div>
      <div class="label">Costs</div>
      <div class="rows" data-testid="costs">
        <Row label="Swap amount">{sat(c.amount)}</Row>
        <Row label="Bitcoin fee to lock it">{withFee(sat(c.lockFee ?? 0), 'unknown')}</Row>
        <Row label="Total from your wallet" strong>
          {withFee(sat(c.pay), `at least ${sat(c.pay)}`)}
        </Row>
        <Row label="Nexus fee to claim the NEX">
          {nex(c.claimFee)} NEX ({about(sat(c.claimFeeSats))})
        </Row>
        <Row label="Offer price">{sat(c.price)} a NEX</Row>
        <Row label="Your price with fees" strong>
          {c.effective === null
            ? 'no NEX: fees take it all'
            : withFee(`${sat(c.effective)} a NEX`, `at least ${sat(c.effective)} a NEX`)}
        </Row>
        <Row label="Fees" strong>
          {withFee(`${percent(c.feeShare)} of what you pay`, 'unknown')}
        </Row>
      </div>
      {fee === null && (
        <span class="small muted">The Bitcoin fee to lock could not be priced right now: the totals leave it out.</span>
      )}
      <span class="small muted">
        If the seller vanishes after your BTC is locked, {sat(c.refunded)} comes back to your wallet in{' '}
        {refundAfter(offer)}: cancel and refund each pay a {sat(offer.template.btc_fee)} Bitcoin fee from it, and the
        lock fee is spent. Keep this page open for the refund: nothing refunds while it is closed.
      </span>
      <div class="box strong-border small">Nexus is young; confirmations are cheap to fake today. Swap small amounts.</div>
      {error !== null && (
        <p role="alert" class="error">
          {bounded(error)}
        </p>
      )}
      <button type="button" class="primary big-button" disabled={starting} onClick={start}>
        Start swap
      </button>
      <button type="button" class="link center" onClick={props.onBack}>
        Back
      </button>
    </section>
  );
}
