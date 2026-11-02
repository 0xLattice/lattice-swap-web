import { useEffect, useState } from 'preact/hooks';
import type { Wallet } from 'lattice-swap-driver';
import { call } from 'lattice-swap-driver/wasm.js';
import { bounded, btc, nex, nexFor, refundAfter } from '../format';
import type { Offer } from '../types';
import { Row } from './ui';

/** The funding's fee, as the driver judges what the wallet needs before
 * it takes the offer: `walletNeed` over its spendable outputs at its fee
 * rate, less the amount. */
async function fundingFee(wallet: Wallet, amount: number): Promise<number> {
  const { need } = call('walletNeed', { utxos: await wallet.spendable(), amount, fee_rate: await wallet.feeRate() });
  return need - amount;
}

export function Review(props: {
  wallet: Wallet;
  offer: Offer;
  sats: number;
  nexAddress: string;
  onStart: () => Promise<void>;
  onBack: () => void;
}) {
  const { offer, sats } = props;
  const [fee, setFee] = useState<string>('…');
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
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
