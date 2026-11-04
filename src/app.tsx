// The page: the driver's wallet and one buyer at a time, and the screens
// over them. Every state shown is the driver's `status()`.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Buyer, DEFAULTS, IndexedDBStore, Wallet } from 'lattice-swap-driver';
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

/** `buyer.status()`, whose JSDoc types it only as an object. */
const statusOf = (buyer: Buyer) => buyer.status() as Status;

/** Whether a swap is still the buyer's to carry on: not ended, its offer
 * not gone, and not cancelled. Only such a swap is resumed or shown as
 * the header's running swap. */
export const unfinished = (status: Status) =>
  status.outcome === null && status.step !== 'offer-gone' && status.step !== 'cancelled';

export interface OffersState {
  list: Listed[];
  error: string | null;
  loaded: boolean;
}

export function App({ config }: { config: AppConfig }) {
  const [screen, setScreen] = useState<Screen>('swap');
  const [otherTab, setOtherTab] = useState(false);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [buyer, setBuyer] = useState<Buyer | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [runEnded, setRunEnded] = useState(false);
  const [offers, setOffers] = useState<OffersState>({ list: [], error: null, loaded: false });
  const [chosen, setChosen] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [nexAddress, setNexAddress] = useState('');
  const [backedUp, setBackedUp] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [evictable, setEvictable] = useState(false);
  /** The punished swap this page resumed, asking the seller for `s`. */
  const [asked, setAsked] = useState<string | null>(null);
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
      onAcquired: () => setOtherTab(false),
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
    setStatus(statusOf(next));
    setRunEnded(false);
    next.addEventListener('status', (event) => {
      if (run.current === stop) setStatus((event as CustomEvent<Status>).detail);
    });
    next
      .run(stop.signal)
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        if (run.current !== stop) return;
        setRunEnded(true);
        setBalance(statusOf(next).wallet);
      });
  }

  /** The swap the store holds that has not ended, carried on: the one
   * running if any; else one punished, which its resume has ask the
   * seller for `s` once more and claim the NEX with it; else one prepared
   * and waiting for funds. */
  async function resume(w: Wallet) {
    const running = await w.running();
    const ids = running !== null ? [running] : await w.swaps();
    let waiting: Buyer | null = null;
    for (const id of ids) {
      const resumed = await Buyer.resume(w, id);
      const resumedStatus = statusOf(resumed);
      if (!unfinished(resumedStatus)) continue;
      // None running before, one running once resumed was punished: it
      // goes before one waiting for funds.
      if (running === null && !resumedStatus.running) {
        waiting ??= resumed;
        continue;
      }
      if (running === null) setAsked(id);
      await follow(resumed);
      setScreen('status');
      return;
    }
    if (waiting !== null) {
      await follow(waiting);
      setScreen('status');
    }
  }

  async function open(): Promise<Wallet> {
    const w = await Wallet.open(driverConfig);
    setWallet(w);
    return w;
  }

  /** Asks the browser to keep the store once it holds something to lose:
   * a wallet made or restored, or a swap prepared. Without persistent
   * storage the browser may clear it under storage pressure. */
  async function keep() {
    try {
      if (await navigator.storage.persisted()) return;
      setEvictable(!(await navigator.storage.persist()));
    } catch {
      // A browser without the API, or one that would not answer: nothing
      // to say.
    }
  }

  async function made(): Promise<Wallet> {
    const w = await open();
    keep();
    return w;
  }

  const poll = (driverConfig as { poll?: number }).poll ?? DEFAULTS.poll;

  // The wallet is opened at once if the store holds one; otherwise only
  // when the buyer starts a swap or makes one, so a fresh browser makes no
  // key and can still restore one. A failed resume, a store read, is tried
  // again on the driver's poll.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let opened: Wallet | null = null;
    const attempt = async () => {
      // A swap is followed already: one the buyer started, or restored.
      if (run.current !== null) return;
      try {
        if (opened === null) {
          if (!(await Wallet.exists(driverConfig))) return;
          opened = await open();
          keep();
        }
        await resume(opened);
        if (!stopped) setError(null);
      } catch (e) {
        if (stopped || run.current !== null) return;
        setError(`Could not resume your swap, trying again: ${(e as Error).message}`);
        timer = setTimeout(attempt, poll);
      }
    };
    attempt();
    return () => {
      stopped = true;
      clearTimeout(timer);
      run.current?.abort();
    };
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
    const timer = setInterval(read, poll);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [wallet, live, poll]);

  const shownBalance: Balance | null = live && status ? status.wallet : balance;
  const swapRuns = status?.running ?? false;
  const active = buyer !== null && status !== null && unfinished(status);
  const { offer, gone: pickGone } = offerFor(offers.list, chosen);

  /** Hands the buyer `text` as the file `name`: through the host's
   * `save`, if it gives one. */
  const save = (name: string, text: string, type?: string) =>
    config.save ? config.save(name, text) : download(name, text, type);

  async function backup() {
    if (wallet === null) return;
    try {
      const { name, file } = await wallet.backup();
      await save(name, file);
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
    keep();
    await follow(prepared);
    setScreen('status');
  }

  /** Drops the swap while it has not taken its offer; the driver refuses
   * once it has, and the refusal is shown. */
  async function cancel() {
    if (buyer === null) return;
    try {
      await buyer.cancel();
      clear('swap');
    } catch (e) {
      const message = (e as Error).message;
      setError(
        /has taken its offer/.test(message)
          ? 'Not cancelled: the swap has already taken its offer. It runs on to its end or its refund; keep this page open.'
          : message,
      );
    }
  }

  function clear(next: Screen) {
    run.current?.abort();
    run.current = null;
    setBuyer(null);
    setStatus(null);
    setChosen(null);
    setScreen(next);
  }

  /** The file's wallet, and the swap it runs if this page follows
   * another: restore refuses a file whose swap would run beside the
   * store's, so at most one runs. */
  async function restored(file: string) {
    let w: Wallet;
    try {
      w = await Wallet.restore(driverConfig, file);
    } catch (e) {
      const message = (e as Error).message;
      if (/would both run/.test(message)) {
        throw new Error('Not restored: this file holds a running swap, and this browser runs another. One swap at a time: restore it once that one ends.');
      }
      throw e;
    }
    setWallet(w);
    keep();
    const running = await w.running();
    if (running !== null ? running !== buyer?.swapId : !active) await resume(w);
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
        onReview={async () => setScreen('review')}
      />
    );
  else if (screen === 'review' && offer !== null)
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
      status.step === 'fund-wallet' || status.step === 'offer-gone' || status.step === 'cancelled' ? (
        <Fund status={status} onPickAnother={() => clear('offers')} onCancel={cancel} />
      ) : (
        <Progress
          status={status}
          backedUp={backedUp.has(status.swapId)}
          asking={asked === status.swapId}
          save={save}
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
        onOpen={made}
        onBackup={backup}
      />
    );
  else if (screen === 'settings') body = <Settings config={config} onRestore={restored} />;
  else body = null;

  return (
    <div class="lattice-swap">
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
              {asked === status.swapId ? 'Swap · asking the seller' : status.running ? 'Swap · running' : 'Swap · waiting for funds'}
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
        {evictable && (screen === 'wallet' || (screen === 'status' && status?.step === 'fund-wallet')) && (
          <p role="status" class="small muted">
            This browser may clear this wallet's data. Download the recovery file.
          </p>
        )}
        {body}
      </main>
    </div>
  );
}
