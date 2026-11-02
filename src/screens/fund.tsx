import { btc } from '../format';
import type { Status } from '../types';
import { Address, Row } from './ui';

const amount = (sats: number | null) => (sats === null ? '…' : `${btc(sats)} BTC`);

/** `status().step` `fund-wallet`, or `offer-gone`. */
export function Fund({ status, onPickAnother }: { status: Status; onPickAnother: () => void }) {
  if (status.step === 'offer-gone') {
    return (
      <section class="narrow">
        <h1>Fund your wallet</h1>
        <div role="status" class="box strong-border">
          <span class="strong">That offer is gone. Your funds are still in your wallet; pick another.</span>
          {status.warning !== null && <span class="small muted">{status.warning}</span>}
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
      {status.warning !== null && (
        <p role="alert" class="error">
          {status.warning}
        </p>
      )}
    </section>
  );
}
