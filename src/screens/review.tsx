import { useEffect, useState } from 'preact/hooks';
import type { Wallet } from 'lattice-swap-driver';
import { costs, percent, sat } from '../costs';
import { bounded, btc, nex, refundAfter } from '../format';
import type { Offer } from '../types';
import { Row } from './ui';

/** The funding's fee: what the wallet needs for the swap, as the driver
 * judges it before taking the offer, less the amount. */
async function fundingFee(wallet: Wallet, amount: number): Promise<number> {
  const { need } = await wallet.need(amount);
  return need - amount;
}

export function Review(props: {
  /** Null in a browser with no wallet yet: none is made to price the
   * fee, only once the buyer starts. */
  wallet: Wallet | null;
  offer: Offer;
  sats: number;
  nexAddress: string;
  onStart: () => Promise<void>;
  onBack: () => void;
}) {
  const { offer, sats } = props;
  /** The lock fee: null while unknown, undefined while it is priced. */
  const [fee, setFee] = useState<number | null | undefined>(props.wallet === null ? null : undefined);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (props.wallet === null) return;
    fundingFee(props.wallet, sats).then(setFee, () => setFee(null));
  }, [props.wallet, sats]);
  const c = costs(offer, sats, fee ?? null);
  /** "~" on a figure that counts the lock fee: an estimate. */
  const est = fee != null ? '~' : '';
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
        <Row label="Bitcoin fee to lock it">{fee === undefined ? '…' : fee === null ? 'unknown' : `~${sat(fee)}`}</Row>
        <Row label="Nexus fee to claim the NEX">
          {nex(c.claimFee)} NEX (~{sat(c.claimFeeSats)})
        </Row>
        <Row label="Total from your wallet" strong>
          {est}
          {sat(c.pay)}
        </Row>
        <Row label="Offer price">{sat(c.price)} a NEX</Row>
        <Row label="Your price with fees" strong>
          {c.effective === null ? 'no NEX: fees take it all' : `${est}${sat(c.effective)} a NEX`}
        </Row>
        <Row label="Fees" strong>
          {est}
          {percent(c.feeShare)} of what you pay
        </Row>
      </div>
      {fee === null && <span class="small muted">Not counting the Bitcoin fee to lock: it is priced once you have a wallet.</span>}
      <span class="small muted">
        If the swap fails, {sat(c.refunded)} comes back to your wallet in {refundAfter(offer)}: cancel and refund
        each pay a {sat(offer.template.btc_fee)} Bitcoin fee from it, and the lock fee is spent. Keep this page open
        for the refund: nothing refunds while it is closed.
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
