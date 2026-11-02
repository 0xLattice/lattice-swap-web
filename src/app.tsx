// The page: the driver's wallet and one buyer at a time, and the screens
// over them. Every state shown is the driver's `status()`.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Buyer, DEFAULTS, IndexedDBStore, Wallet } from 'lattice-swap-driver';
import { swapKey } from 'lattice-swap-driver/wallet.js';
import type { AppConfig } from './config';
import { bounded, btc, parseBtc } from './format';
import { listOffers, offerFor } from './offers';
import type { Balance, Listed, Status } from './types';
import { download } from './download';
import { SwapForm } from './screens/swap';
import { Review } from './screens/review';
import { Fund } from './screens/fund';
import { Progress } from './screens/progress';
import { WalletScreen } from './screens/wallet';
import { Settings } from './screens/settings';
import { Offers } from './screens/offers';
import { OtherTab } from './screens/other-tab';

type Screen = 'swap' | 'review' | 'status' | 'offers' | 'wallet' | 'settings';

/** Steps in which the swap's funding holds the wallet's outputs: the
 * driver refuses a withdrawal then. */
const RUNNING = new Set(['swapping', 'finishing', 'refunding']);

export interface OffersState {
  list: Listed[];
  error: string | null;
  loaded: boolean;
}

/** What a swap pays and gets, from its record: `status()` does not say. */
export interface Amounts {
  btc: number;
  price: number;
}

export function App({ config }: { config: AppConfig }) {
  const [screen, setScreen] = useState<Screen>('swap');
  const [otherTab, setOtherTab] = useState(false);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [buyer, setBuyer] = useState<Buyer | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [runEnded, setRunEnded] = useState(false);
  const [amounts, setAmounts] = useState<Amounts | null>(null);
  const [offers, setOffers] = useState<OffersState>({ list: [], error: null, loaded: false });
  const [chosen, setChosen] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [nexAddress, setNexAddress] = useState('');
  const [backedUp, setBackedUp] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const run = useRef<AbortController | null>(null);

  const genesis = config.nexusGenesis ?? DEFAULTS.nexusGenesis;
  const driverConfig = useMemo(
    () => ({
      network: config.network,
      esplora: config.esplora,
      nexus: config.nexus,
      nexusGenesis: genesis,
      ...config.driver,
      store: (config.driver?.store as IndexedDBStore | undefined) ?? new IndexedDBStore(),
      onWaiting: () => setOtherTab(true),
    }),
    // One store and one wallet for the page's life.
    [],
  );

  /** Follows `next`, run until it ends, its offer goes, or the page
   * closes. */
  async function follow(next: Buyer) {
    run.current?.abort();
    const stop = new AbortController();
    run.current = stop;
    setBuyer(next);
    setStatus(next.status());
    setRunEnded(false);
    const record = await driverConfig.store.get(swapKey(next.swapId));
    setAmounts(record ? { btc: record.policy.btc_amount, price: record.policy.price } : null);
    next.addEventListener('status', (event) => setStatus((event as CustomEvent<Status>).detail));
    next
      .run(stop.signal)
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        if (run.current !== stop) return;
        setRunEnded(true);
        setBalance(next.status().wallet);
      });
  }

  /** The swap the store holds that has not ended, carried on: the one
   * running if any, else one prepared and waiting for funds. */
  async function resume(w: Wallet) {
    const running = await w.running();
    const ids = running !== null ? [running] : await w.swaps();
    for (const id of ids) {
      const resumed = await Buyer.resume(w, id);
      if (resumed.status().outcome === null) {
        await follow(resumed);
        setScreen('status');
        return;
      }
    }
  }

  async function open(): Promise<Wallet> {
    const w = await Wallet.open(driverConfig);
    setOtherTab(false);
    setWallet(w);
    return w;
  }

  // The wallet is opened at once if the store holds one; otherwise only
  // when the buyer needs it, so a fresh browser can still restore one.
  useEffect(() => {
    (async () => {
      if ((await driverConfig.store.get('wallet')) === null) return;
      await resume(await open());
    })().catch((e: Error) => setError(e.message));
    return () => run.current?.abort();
  }, []);

  async function refreshOffers() {
    if (config.relay === null) return;
    try {
      setOffers({ list: await listOffers(config.relay, config.network, genesis), error: null, loaded: true });
    } catch (e) {
      setOffers((was) => ({ ...was, error: (e as Error).message, loaded: true }));
    }
  }

  useEffect(() => {
    if (screen === 'swap' || screen === 'offers') refreshOffers();
  }, [screen]);

  // The balance comes with each status while a swap runs; otherwise it
  // is read on the driver's poll.
  const live = buyer !== null && !runEnded;
  useEffect(() => {
    if (wallet === null || live) return;
    let stopped = false;
    const read = () =>
      wallet.balance().then(
        (b: Balance) => !stopped && setBalance(b),
        () => {},
      );
    read();
    const timer = setInterval(read, (driverConfig as { poll?: number }).poll ?? DEFAULTS.poll);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [wallet, live, driverConfig]);

  const shownBalance: Balance | null = live && status ? status.wallet : balance;
  const swapRuns = status !== null && RUNNING.has(status.step);
  const active = buyer !== null && status !== null && status.outcome === null && status.step !== 'offer-gone';
  const { offer, gone: pickGone } = offerFor(offers.list, chosen);

  async function backup() {
    if (wallet === null) return;
    try {
      const { name, file } = await wallet.backup();
      download(name, file);
      // Only a file taken once it covers the lock answers the lock's prompt:
      // one taken before holds the wallet key and no more.
      if (status?.backupCovers === 'lock') setBackedUp(new Set(backedUp).add(status.swapId));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function start() {
    if (offer === null) return;
    const btcAmount = parseBtc(amount);
    if (btcAmount === null) return;
    const w = wallet ?? (await open());
    const prepared = await Buyer.prepare(w, {
      offer: offer.text,
      policy: { ...config.bounds, btc_amount: btcAmount, price: offer.offer.quote.price },
      nexAddress: nexAddress.trim(),
    });
    await follow(prepared);
    setScreen('status');
  }

  function clear(next: Screen) {
    run.current?.abort();
    run.current = null;
    setBuyer(null);
    setStatus(null);
    setAmounts(null);
    setChosen(null);
    setScreen(next);
  }

  async function restored(file: string) {
    const w = await Wallet.restore(driverConfig, file);
    setOtherTab(false);
    setWallet(w);
    if (!active) await resume(w);
  }

  const tab = (name: Screen, label: string) => (
    <button type="button" class={screen === name ? 'tab on' : 'tab'} onClick={() => setScreen(name)}>
      {label}
    </button>
  );

  let body;
  if (otherTab) body = <OtherTab />;
  else if (screen === 'swap')
    body = (
      <SwapForm
        relay={config.relay}
        offers={offers}
        offer={offer}
        pickGone={pickGone}
        onRepick={() => setScreen('offers')}
        amount={amount}
        setAmount={setAmount}
        nexAddress={nexAddress}
        setNexAddress={setNexAddress}
        balance={shownBalance}
        onWallet={() => setScreen('wallet')}
        onReview={async () => {
          if (wallet === null) await open();
          setScreen('review');
        }}
      />
    );
  else if (screen === 'review' && offer !== null && wallet !== null)
    body = (
      <Review
        wallet={wallet}
        offer={offer.offer}
        sats={parseBtc(amount) ?? 0}
        nexAddress={nexAddress.trim()}
        onStart={start}
        onBack={() => setScreen('swap')}
      />
    );
  else if (screen === 'status' && status !== null)
    body =
      status.step === 'fund-wallet' || status.step === 'offer-gone' ? (
        <Fund status={status} onPickAnother={() => clear('offers')} />
      ) : (
        <Progress
          status={status}
          amounts={amounts}
          backedUp={backedUp.has(status.swapId)}
          onBackup={backup}
          onWithdraw={() => setScreen('wallet')}
          onSwapAgain={() => clear('swap')}
        />
      );
  else if (screen === 'offers')
    body = (
      <Offers
        relay={config.relay}
        offers={offers}
        onPick={(text) => {
          setChosen(text);
          setScreen('swap');
        }}
      />
    );
  else if (screen === 'wallet')
    body = (
      <WalletScreen
        wallet={wallet}
        balance={shownBalance}
        swapRuns={swapRuns}
        onOpen={open}
        onBackup={backup}
      />
    );
  else if (screen === 'settings') body = <Settings config={config} onRestore={restored} />;
  else body = null;

  return (
    <div class="page">
      <header>
        <div class="brand">Lattice Swap</div>
        <nav aria-label="Main">
          {tab('swap', 'Swap')}
          {tab('offers', 'Offers')}
        </nav>
        <div class="side">
          {tab('wallet', shownBalance?.confirmed != null ? `Wallet · ${btc(shownBalance.confirmed)} BTC` : 'Wallet')}
          {tab('settings', 'Settings')}
          {active && screen !== 'status' && (
            <button type="button" class="tab running" onClick={() => setScreen('status')}>
              Swap · running
            </button>
          )}
        </div>
      </header>
      <main>
        {error !== null && (
          <p role="alert" class="error">
            {bounded(error)}
          </p>
        )}
        {body}
      </main>
    </div>
  );
}
