import { useEffect, useState } from 'preact/hooks';
import type { Wallet } from 'lattice-swap-driver';
import { bounded, btc, nex, nexFor, refundAfter } from '../format';
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
  const [fee, setFee] = useState<string>(props.wallet === null ? 'unknown' : '…');
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (props.wallet === null) return;
    fundingFee(props.wallet, sats).then(
      (f) => setFee(`~${btc(f)} BTC`),
      () => setFee('unknown'),
    );
  }, [props.wallet, sats]);
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
          {nex(nexFor(sats, offer.quote.price))} NEX
        </Row>
        <Row label="Price">1 NEX = {btc(offer.quote.price)} BTC</Row>
        <Row label="Network fee">{fee}</Row>
        <Row label="To">
          <code class="break">{props.nexAddress}</code>
        </Row>
      </div>
      <span class="small muted">
        If the seller vanishes, your BTC is back in your wallet in {refundAfter(offer)}. Keep this page open for the
        refund: nothing refunds while it is closed.
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
