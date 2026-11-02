import { useState } from 'preact/hooks';
import { bounded, btc } from '../format';
import type { Status } from '../types';
import { Address, Row } from './ui';

const amount = (sats: number | null) => (sats === null ? '…' : `${btc(sats)} BTC`);

/** `status().step` `fund-wallet`, `offer-gone` or `cancelled`. */
export function Fund({
  status,
  onPickAnother,
  onCancel,
}: {
  status: Status;
  onPickAnother: () => void;
  /** Cancels the untaken swap; a refusal is the page's to show. */
  onCancel: () => Promise<void>;
}) {
  const [cancelling, setCancelling] = useState(false);
  if (status.step === 'cancelled') {
    return (
      <section class="narrow">
        <h1>Swap cancelled</h1>
        <div role="status" class="box strong-border">
          <span class="strong">Nothing was sent. Your funds are still in your wallet.</span>
          <button type="button" class="primary" onClick={onPickAnother}>
            Pick another offer
          </button>
        </div>
      </section>
    );
  }
  if (status.step === 'offer-gone') {
    return (
      <section class="narrow">
        <h1>Offer gone</h1>
        <div role="status" class="box strong-border">
          <span class="strong">That offer is gone. Your funds are still in your wallet; pick another.</span>
          {status.warning !== null && <span class="small muted">{bounded(status.warning)}</span>}
          <button type="button" class="primary" onClick={onPickAnother}>
            Pick another offer
          </button>
        </div>
      </section>
    );
  }
  return (
    <section class="narrow">
      <h1>Fund your wallet</h1>
      <Address label="Send BTC to" address={status.wallet.address} />
      <div class="rows">
        <Row label="Needed" strong>
          {amount(status.need)}
        </Row>
        <Row label="Confirmed">{amount(status.wallet.confirmed)}</Row>
        <Row label="Unconfirmed">{amount(status.wallet.unconfirmed)}</Row>
      </div>
      <span class="small muted">The swap starts once enough is confirmed.</span>
      <button
        type="button"
        class="secondary"
        disabled={cancelling}
        onClick={() => {
          setCancelling(true);
          onCancel().finally(() => setCancelling(false));
        }}
      >
        Cancel swap
      </button>
      {status.warning !== null && (
        <p role="alert" class="error">
          {bounded(status.warning)}
        </p>
      )}
    </section>
  );
}
