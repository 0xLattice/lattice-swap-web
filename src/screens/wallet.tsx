import { useState } from 'preact/hooks';
import type { Wallet } from 'lattice-swap-driver';
import { btc } from '../format';
import type { Balance } from '../types';
import { Address } from './ui';

export function WalletScreen(props: {
  wallet: Wallet | null;
  balance: Balance | null;
  /** A swap's funding holds the wallet's outputs: `Wallet#withdraw`
   * refuses then. */
  swapRuns: boolean;
  onOpen: () => Promise<Wallet>;
  onBackup: () => void;
}) {
  const { wallet, balance, swapRuns } = props;
  const [to, setTo] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (wallet === null) {
    return (
      <section class="narrow">
        <h1>Wallet</h1>
        <span class="small muted">This browser holds no wallet yet. Make one to deposit BTC, or restore one in Settings.</span>
        <button type="button" class="primary" onClick={() => props.onOpen().catch((e: Error) => setError(e.message))}>
          Make a wallet
        </button>
        {error !== null && (
          <p role="alert" class="error">
            {error}
          </p>
        )}
      </section>
    );
  }
  const withdraw = async () => {
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      // The txid: the driver's JSDoc-less `exclusive` hides it from TypeScript.
      setSent((await wallet.withdraw(to.trim())) as unknown as string);
      setTo('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="narrow">
      <h1>Wallet</h1>
      <div class="balance">
        <span class="big" data-testid="balance">
          {balance?.confirmed != null ? btc(balance.confirmed) : '…'} BTC
        </span>
        {!!balance?.unconfirmed && <span class="small muted">+ {btc(balance.unconfirmed)} BTC unconfirmed</span>}
      </div>
      <Address label="Deposit to" address={wallet.address} />
      <div class="field top-rule">
        <label for="withdraw" class="label">
          Withdraw everything to
        </label>
        <input
          id="withdraw"
          class="text"
          placeholder="Your Bitcoin address"
          autocomplete="off"
          value={to}
          onInput={(e) => setTo(e.currentTarget.value)}
        />
        <button type="button" class="primary" disabled={swapRuns || busy || to.trim() === ''} onClick={withdraw}>
          Withdraw
        </button>
        {swapRuns && <span class="small muted">Withdraw is unavailable while a swap runs.</span>}
        {sent !== null && (
          <span class="small">
            Sent: <code class="break">{sent}</code>
          </span>
        )}
        {error !== null && (
          <p role="alert" class="error">
            {error}
          </p>
        )}
      </div>
      <button type="button" class="link" onClick={props.onBackup}>
        Download recovery file
      </button>
    </section>
  );
}
