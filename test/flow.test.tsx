// Whole flows through the page, against the driver's fakes.

import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { DEFAULTS, MemoryStore, Wallet, Buyer, lockFee } from 'lattice-swap-driver';
import { wasm } from 'lattice-swap-driver/wasm.js';
import { Locks, until } from '../vendor/lattice-swap/web/driver/test/fakes.js';
import { App, readable } from '../src/app';
import { nex, parseBtc } from '../src/format';
import { about, costs, percent, sat } from '../src/costs';
import {
  call,
  Chain,
  confirm,
  deposit,
  DirectoryChain,
  driverOf,
  esplora,
  naming,
  nexus,
  posted,
  POLICY,
  relayOf,
  serve,
  servers,
  signedOffer,
  world,
  type World,
} from './world';
import { buildConfig, policyFor } from '../src/config';
import { listOffers, MAX_FOUND_RELAY_BYTES, MAX_OFFERS } from '../src/offers';
import { DIRECTORY_RETRY, MAX_DIRECTORY_BYTES, MAX_DIRECTORY_RELAYS, pickFound, readDirectory } from '../src/directory';

const WAIT = { timeout: 20_000 };
const sats = (amount: string) => parseBtc(amount)!;

const click = (name: string | RegExp) => fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name }));
const tab = (name: RegExp) => fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name }));

/** From the board to the Fund screen: the test offer at `amount` BTC. */
async function startSwap(w: World, amount = '0.01') {
  render(<App config={w.config} />);
  await screen.findByText(/best of 1/, {}, WAIT);
  fireEvent.input(screen.getByLabelText('You pay'), { target: { value: amount } });
  fireEvent.input(screen.getByLabelText('Send NEX to'), { target: { value: w.nexAddress } });
  click('Swap');
  await screen.findByRole('heading', { name: 'Review swap' }, WAIT);
  // A fresh browser: the lock fee priced from the Esplora's fee rate,
  // with no key made for it, and counted in the price and the fees.
  const row = (label: string) => screen.getByText(label).nextSibling?.textContent;
  const fee = await lockFee(w.config.esplora, sats(amount));
  await waitFor(() => expect(row('Bitcoin fee to lock it')).toBe(`~${sat(fee)}`), WAIT);
  const c = costs(call('decodeOffer', w.offer), sats(amount), fee);
  expect(row('Fees')).toBe(`${about(percent(c.feeShare))} of what you pay`);
  expect(c.feeShare).toBeGreaterThan(0);
  expect(await w.store.get('wallet')).toBeNull();
  click('Start swap');
  await screen.findByRole('heading', { name: 'Fund your wallet' }, WAIT);
  const address = (await Wallet.open(driverOf(w))).address as string;
  return address;
}

describe('a swap through the page', () => {
  test('funds, locks, stalls on the seller, refunds, then withdraws', async () => {
    const w = await world();
    const address = await startSwap(w);
    // The Fund screen: what the lock needs, nothing in yet.
    await waitFor(() => expect(screen.getByText('Needed').nextSibling?.textContent).toMatch(/^0\.010\d+ BTC$/), WAIT);
    expect(screen.getByText('Confirmed').nextSibling?.textContent).toBe('0.00000000 BTC');
    deposit(w, address, 1_100_000, false);
    await waitFor(() => expect(screen.getByText('Unconfirmed').nextSibling?.textContent).toBe('0.01100000 BTC'), WAIT);
    expect(screen.getByRole('heading', { name: 'Fund your wallet' })).toBeTruthy();

    // Confirmed, the offer is taken and the lock funded.
    deposit(w, address, 1_100_000);
    await until(() => posted(w).length === 1, 20_000);
    await screen.findByText('Lock your BTC', {}, WAIT);
    // The recovery file covers the lock now: asked for, not required.
    fireEvent.click(await screen.findByRole('button', { name: 'Download recovery file' }, WAIT));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Download recovery file' })).toBeNull(), WAIT);

    // The lock in a block: the deadlines, and on to the seller's step.
    confirm(w, posted(w)[0]);
    await screen.findByText(/^If the swap stalls, come back by .+ and keep this page open until your refund confirms\./, {}, WAIT);
    const current = () => document.querySelector('li[aria-current="step"]')?.textContent ?? '';
    await waitFor(() => expect(current()).toMatch(/Seller locks NEX/), WAIT);

    // Withdraw is off while the swap runs.
    tab(/^Wallet/);
    const withdraw = screen.getByRole('button', { name: 'Withdraw' }) as HTMLButtonElement;
    fireEvent.input(screen.getByLabelText('Withdraw everything to'), { target: { value: call('newBitcoinKey', 'regtest').address } });
    expect(withdraw.disabled).toBe(true);
    expect(screen.getByText('Withdraw is unavailable while a swap runs.')).toBeTruthy();
    tab(/^Swap · running$/);

    // The seller never locks: at t1 cancel, then the refund, the page
    // asked to stay open throughout.
    w.chain.mine(20 - 1);
    await until(() => posted(w).length === 2, 20_000);
    await screen.findByText('Refunding your BTC', {}, WAIT);
    expect(screen.getByText('Keep this page open')).toBeTruthy();
    // Withdraw is still off: the refund spends the lock to the wallet.
    tab(/^Wallet/);
    fireEvent.input(screen.getByLabelText('Withdraw everything to'), { target: { value: call('newBitcoinKey', 'regtest').address } });
    expect((screen.getByRole('button', { name: 'Withdraw' }) as HTMLButtonElement).disabled).toBe(true);
    tab(/^Swap · running$/);
    await screen.findByText('Refunding your BTC', {}, WAIT);
    confirm(w, posted(w)[1]);
    await until(() => posted(w).length === 3, 20_000);
    confirm(w, posted(w)[2]);
    await screen.findByText('Refunded. Your BTC is back in your wallet.', {}, WAIT);
    expect(screen.queryByText('Keep this page open')).toBeNull();

    // Withdraw is back once the swap is over.
    click('Withdraw');
    await screen.findByRole('heading', { name: 'Wallet' });
    fireEvent.input(screen.getByLabelText('Withdraw everything to'), { target: { value: call('newBitcoinKey', 'regtest').address } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Withdraw' }) as HTMLButtonElement).disabled).toBe(false), WAIT);
  });

  test('a host’s save takes the recovery file and the reminder, and nothing downloads', async () => {
    const w = await world();
    const save = vi.fn();
    w.config.save = save;
    vi.mocked(URL.createObjectURL).mockClear();
    const address = await startSwap(w);
    deposit(w, address, 1_100_000);
    await until(() => posted(w).length === 1, 20_000);
    fireEvent.click(await screen.findByRole('button', { name: 'Download recovery file' }, WAIT));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), WAIT);
    expect(save.mock.calls[0][0]).toMatch(/\.json$/);
    expect(JSON.parse(save.mock.calls[0][1]).wallet).toBeTruthy();
    confirm(w, posted(w)[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Save reminder (.ics)' }, WAIT));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toMatch(/^lattice-swap-.+\.ics$/);
    expect(save.mock.calls[1][1]).toMatch(/^BEGIN:VCALENDAR/);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  test('an offer whose seller is gone says so, and the buyer picks another', async () => {
    const w = await world();
    w.seller.open = async () => {
      throw new Error('the session ended');
    };
    const address = await startSwap(w);
    deposit(w, address, 1_100_000);
    await screen.findByText('That offer is gone. Your funds are still in your wallet; pick another.', {}, WAIT);
    expect(screen.getByText('the offer is gone: the session ended')).toBeTruthy();
    click('Pick another offer');
    await screen.findByRole('heading', { name: 'Offers' });
    expect(w.a.posted).toEqual([]);
  });

  test('a recovery file taken before the lock does not answer the lock’s prompt', async () => {
    const w = await world();
    const address = await startSwap(w);
    // Taken from the Wallet tab while funding: it holds the wallet key alone.
    tab(/^Wallet/);
    click('Download recovery file');
    // Not yet running: the offer is not taken.
    tab(/^Swap · waiting for funds$/);
    deposit(w, address, 1_100_000);
    await until(() => posted(w).length === 1, 20_000);
    await screen.findByText('Lock your BTC', {}, WAIT);
    await screen.findByRole('button', { name: 'Download recovery file' }, WAIT);
  });

  test('an offer picked that leaves the relay must be picked again', async () => {
    const w = await world();
    render(<App config={w.config} />);
    await screen.findByText(/best of 1/, {}, WAIT);
    tab(/^Offers/);
    await screen.findByRole('table', {}, WAIT);
    click('Swap');
    await screen.findByText(/1 NEX =/, {}, WAIT);
    w.listed.splice(0);
    // The list is read again on coming back to the swap.
    tab(/^Offers/);
    tab(/^Swap$/);
    await screen.findByText('The offer you picked is gone', {}, WAIT);
    expect(screen.queryByText(/1 NEX =/)).toBeNull();
    expect((within(screen.getByRole('main')).getByRole('button', { name: 'Swap' }) as HTMLButtonElement).disabled).toBe(true);
    click('Pick another offer');
    await screen.findByRole('heading', { name: 'Offers' });
  });

  test('the buyer cancels from the fund screen, and a reload does not resume it', async () => {
    const w = await world();
    await startSwap(w);
    const id = JSON.parse(w.offer).template.swap_id;
    expect(await w.store.get(`swap:${id}`)).not.toBeNull();
    click('Cancel swap');
    await screen.findByLabelText('You pay', {}, WAIT);
    expect(await w.store.get(`swap:${id}`)).toBeNull();
    expect(within(screen.getByRole('banner')).queryByRole('button', { name: /^Swap · / })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // Reloaded: the page opens the wallet and carries no swap on.
    cleanup();
    const resume = vi.spyOn(Buyer, 'resume');
    try {
      render(<App config={w.config} />);
      await screen.findByText(/best of 1/, {}, WAIT);
      await new Promise((r) => setTimeout(r, 200));
      expect(resume).not.toHaveBeenCalled();
      expect(screen.queryByRole('heading', { name: 'Fund your wallet' })).toBeNull();
      expect(within(screen.getByRole('banner')).queryByRole('button', { name: /^Swap · / })).toBeNull();
    } finally {
      resume.mockRestore();
    }
    expect(w.a.posted).toEqual([]);
  });

  test('a cancel once the swap has taken its offer is refused, and the swap runs on', async () => {
    const w = await world();
    // The seller's session opens only when let: the take holds the swap
    // lock from before it dials until it is saved as taken.
    const open = w.seller.open;
    let dialed = false;
    let answer: () => void = () => {};
    const gate = new Promise<void>((resolve) => (answer = resolve));
    w.seller.open = async (...args: unknown[]) => {
      dialed = true;
      await gate;
      return open(...(args as Parameters<typeof open>));
    };
    const address = await startSwap(w);
    deposit(w, address, 1_100_000);
    await until(() => dialed, 20_000);
    click('Cancel swap');
    answer();
    await screen.findByText(
      'Not cancelled: the swap has already taken its offer. It runs on to its end or its refund; keep this page open.',
      {},
      WAIT,
    );
    await until(() => posted(w).length === 1, 20_000);
    await screen.findByText('Lock your BTC', {}, WAIT);
  });

  test('a reload resumes the running swap with one run, through every re-render', async () => {
    const w = await world();
    const address = await startSwap(w);
    deposit(w, address, 1_100_000);
    await until(() => posted(w).length === 1, 20_000);
    await screen.findByText('Lock your BTC', {}, WAIT);
    // Reloaded: the swap is resumed, and its statuses re-render the page.
    cleanup();
    const run = vi.spyOn(Buyer.prototype, 'run');
    try {
      render(<App config={w.config} />);
      await screen.findByText('Lock your BTC', {}, WAIT);
      confirm(w, posted(w)[0]);
      const current = () => document.querySelector('li[aria-current="step"]')?.textContent ?? '';
      await waitFor(() => expect(current()).toMatch(/Seller locks NEX/), WAIT);
      await new Promise((r) => setTimeout(r, 200));
      expect(run).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/running already/)).toBeNull();
    } finally {
      run.mockRestore();
    }
  });

  test('a seller that goes quiet before the lock ends the swap, nothing at stake', async () => {
    const clock = { offset: 0 };
    const w = await world({ extra: { now: () => Date.now() + clock.offset } });
    const open = w.seller.open;
    w.seller.open = async (offer: unknown, onMessage: (message: string) => void) => {
      const session = await open(offer, onMessage);
      const send = session.send;
      // It answers the request, then says nothing.
      session.send = (message: string) => (JSON.parse(message).Request ? send(message) : undefined);
      return session;
    };
    const address = await startSwap(w);
    deposit(w, address, 1_100_000);
    await until(async () => (await w.store.get(`swap:${JSON.parse(w.offer).template.swap_id}`))?.taken, 20_000);
    clock.offset += 61_000;
    await screen.findByText('Stopped before anything was at stake. Your BTC is in your wallet.', {}, WAIT);
    click('Swap again');
    await screen.findByLabelText('You pay');
  });

  test('a fresh browser makes no key until a swap starts', async () => {
    const w = await world();
    render(<App config={w.config} />);
    await screen.findByText(/best of 1/, {}, WAIT);
    tab(/^Wallet/);
    await screen.findByRole('button', { name: 'Make a wallet' });
    expect(await w.store.get('wallet')).toBeNull();
  });

  test('a browser with a wallet prices the fee from it', async () => {
    const w = await world();
    const wallet = await Wallet.open(driverOf(w));
    deposit(w, wallet.address, 1_100_000);
    render(<App config={w.config} />);
    await screen.findByText(/best of 1/, {}, WAIT);
    fireEvent.input(screen.getByLabelText('You pay'), { target: { value: '0.01' } });
    fireEvent.input(screen.getByLabelText('Send NEX to'), { target: { value: w.nexAddress } });
    click('Swap');
    await screen.findByRole('heading', { name: 'Review swap' }, WAIT);
    const { need } = await wallet.need(1_000_000);
    await waitFor(() => expect(screen.getByText('Bitcoin fee to lock it').nextSibling?.textContent).toBe(`~${sat(need - 1_000_000)}`), WAIT);
  });

  test('priced without a wallet, the lock fee is what an empty wallet needs', async () => {
    const w = await world();
    // A fractional estimate, so the target, the rounding and the floor all count.
    w.chain.fees = { '1': 40, '6': 12.3, '144': 0.5 };
    const wallet = await Wallet.open(driverOf(w));
    const { need } = await wallet.need(1_000_000);
    expect(await lockFee(w.config.esplora, 1_000_000)).toBe(need - 1_000_000);
  });

  test('a resume that fails is tried again on the poll', async () => {
    const w = await world();
    const wallet = await Wallet.open(driverOf(w));
    await Buyer.prepare(wallet, { offer: w.offer, policy: POLICY, nexAddress: w.nexAddress });
    // The store fails its first listing.
    const keys = w.store.keys.bind(w.store);
    let fail = 1;
    w.store.keys = async () => {
      if (fail-- > 0) throw new Error('store busy');
      return keys();
    };
    render(<App config={w.config} />);
    await screen.findByRole('heading', { name: 'Fund your wallet' }, WAIT);
    expect(screen.queryByText(/store busy/)).toBeNull();
  });

  test('a retry pending when the buyer starts a swap leaves that swap alone', async () => {
    const w = await world({ extra: { poll: 1500 } });
    await Wallet.open(driverOf(w));
    const keys = w.store.keys.bind(w.store);
    let fail = 1;
    w.store.keys = async () => {
      if (fail-- > 0) throw new Error('store busy');
      return keys();
    };
    const resume = vi.spyOn(Buyer, 'resume');
    try {
      render(<App config={w.config} />);
      await screen.findByText(/Could not resume your swap, trying again: store busy/, {}, WAIT);
      fireEvent.input(screen.getByLabelText('You pay'), { target: { value: '0.01' } });
      fireEvent.input(screen.getByLabelText('Send NEX to'), { target: { value: w.nexAddress } });
      await screen.findByText(/best of 1/, {}, WAIT);
      click('Swap');
      await screen.findByRole('heading', { name: 'Review swap' }, WAIT);
      click('Start swap');
      await screen.findByRole('heading', { name: 'Fund your wallet' }, WAIT);
      // Past the retry's time: it neither resumes the swap a second time nor
      // says it failed.
      await new Promise((r) => setTimeout(r, 2500));
      expect(resume).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: 'Fund your wallet' })).toBeTruthy();
    } finally {
      resume.mockRestore();
    }
  });

  test('offers at a price of 0 or with amounts beyond 2^53 are left out', async () => {
    const w = await world();
    const zero = signedOffer(w.offer, '{"price":0,"min_btc_amount":10000,"max_btc_amount":1000000}');
    const huge = signedOffer(w.offer, '{"price":1,"min_btc_amount":10000,"max_btc_amount":18014398509481984}');
    // Both are offers their seller signed: only the page's rule leaves them
    // out. 2^54 survives JSON in JavaScript exactly, so its signature holds,
    // but is no safe integer.
    expect(call('decodeOffer', zero).quote.price).toBe(0);
    expect(call('decodeOffer', huge).quote.price).toBe(1);
    w.listed.unshift(zero, huge);
    expect((await listOffers(w.config.relays[0], 'regtest', 'genesis')).map((l) => l.text)).toEqual([w.offer]);
    render(<App config={w.config} />);
    await screen.findByText(/best of 1/, {}, WAIT);
    expect(screen.getByText(/1 NEX = 0\.02000000 BTC/)).toBeTruthy();
    fireEvent.input(screen.getByLabelText('You pay'), { target: { value: '0.01' } });
    // 0.5 NEX locked, less the claim's Nexus fee.
    const { nex_fee } = call('decodeOffer', w.offer).template;
    expect(screen.getByTestId('quote').textContent).toBe(nex(500_000 - nex_fee));
  });

  test('withdraws the whole balance when no swap runs', async () => {
    const w = await world();
    const wallet = await Wallet.open(driverOf(w));
    deposit(w, wallet.address, 50_000);
    render(<App config={w.config} />);
    tab(/^Wallet/);
    await waitFor(() => expect(screen.getByTestId('balance').textContent).toBe('0.00050000 BTC'), WAIT);
    fireEvent.input(screen.getByLabelText('Withdraw everything to'), { target: { value: call('newBitcoinKey', 'regtest').address } });
    click('Withdraw');
    await screen.findByText(/^Sent:/, {}, WAIT);
    expect(w.a.posted.length).toBe(1);
  });
});

describe('test coins for mainnet NEX', () => {
  /** The test offer as a seller on `network` offers mainnet NEX. */
  const mainnetNex = (w: World, network: string) => {
    const base = JSON.parse(w.offer);
    base.btc_network = network;
    base.template.nexus_genesis = DEFAULTS.nexusGenesis;
    return call('decodeOffer', signedOffer(JSON.stringify(base), JSON.stringify(base.quote)));
  };
  /** Why the engine refuses `offer` on `network` under `policy`, or null. */
  const refusal = (offer: unknown, network: string, policy: unknown): string | null =>
    wasm.checkOffer(JSON.stringify({ offer, policy, network, nexus_genesis: DEFAULTS.nexusGenesis, fee_estimate: null, min_relay_fee: 0 })) ?? null;

  test('the signet build opts in; mainnet never does, whatever its bounds say', async () => {
    const w = await world();
    const signet = policyFor({ ...w.config, network: 'signet' }, POLICY.btc_amount, POLICY.price);
    expect(signet.test_btc_for_mainnet_nex).toBe(true);
    const bounds = { ...w.config.bounds, test_btc_for_mainnet_nex: 1 };
    const mainnet = policyFor({ ...w.config, network: 'bitcoin', bounds }, POLICY.btc_amount, POLICY.price);
    expect(mainnet.test_btc_for_mainnet_nex).toBe(false);
    expect(mainnet).toMatchObject({ ...w.config.bounds, btc_amount: POLICY.btc_amount, price: POLICY.price });

    // As the engine judges it: mainnet NEX for signet BTC is taken only
    // under the opt-in.
    const offer = mainnetNex(w, 'signet');
    expect(refusal(offer, 'signet', signet)).toBeNull();
    const refused = refusal(offer, 'signet', { ...signet, test_btc_for_mainnet_nex: false });
    expect(refused).toMatch(/^refused: mainnet NEX for signet BTC/);
    expect(readable(refused!)).toBe('Refused: this offer trades real NEX for signet BTC, which is worth nothing.');
    expect(readable('refused: anything else')).toBe('refused: anything else');
  });

  test('the page hands the driver the opt-in on a test network', async () => {
    const w = await world();
    const prepare = vi.spyOn(Buyer, 'prepare');
    try {
      await startSwap(w);
      const policy = expect.objectContaining({ ...w.config.bounds, test_btc_for_mainnet_nex: true });
      expect(prepare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ policy }));
    } finally {
      prepare.mockRestore();
    }
  });
});

describe('restore', () => {
  /** A swap run by the driver alone until its lock is funded, and its
   * recovery file. */
  async function funded(w: World) {
    const wallet = await Wallet.open(driverOf(w));
    const buyer = await Buyer.prepare(wallet, { offer: w.offer, policy: POLICY, nexAddress: w.nexAddress });
    deposit(w, wallet.address, 1_100_000);
    const stop = new AbortController();
    const done = buyer.run(stop.signal);
    await until(() => posted(w).length === 1, 20_000);
    stop.abort();
    await done;
    return { file: (await wallet.backup()).file as string, address: wallet.address as string };
  }

  const upload = (file: string) =>
    fireEvent.change(screen.getByLabelText('Restore from file'), {
      target: { files: [new File([file], 'backup.json', { type: 'application/json' })] },
    });

  test('a fresh browser restores the wallet and carries on with its swap', async () => {
    const w = await world();
    const { file, address } = await funded(w);
    const fresh = { ...w.config, driver: { ...w.config.driver, store: new MemoryStore() } };
    render(<App config={fresh} />);
    tab(/^Settings/);
    upload(file);
    await screen.findByText('Lock your BTC', {}, WAIT);
    // The NEX that arrives, as Review's "You get": the lock less the claim's fee.
    const get = nex(costs(call('decodeOffer', w.offer), sats('0.01'), null).receive);
    expect(get).toBe('0.4999');
    expect(screen.getByRole('heading', { name: `0.01000000 BTC → ${get} NEX` })).toBeTruthy();
    tab(/^Wallet/);
    expect(screen.getByText(address)).toBeTruthy();
  });

  /** A store holding `w`'s wallet and a copy of `record` as swap ff…ff,
   * as `over` changes it. */
  async function beside(w: World, record: Record<string, unknown>, over: Record<string, unknown>) {
    const store = new MemoryStore();
    const wallet = await Wallet.open(driverOf(w));
    await store.put('wallet', { wif: wallet.key.wif });
    await store.put(`swap:${'ff'.repeat(32)}`, { ...record, swap_id: 'ff'.repeat(32), ...over });
    return store;
  }

  test('after a restore the page follows the swap the file runs, and only it', async () => {
    const w = await world();
    const { file } = await funded(w);
    const id = JSON.parse(w.offer).template.swap_id;
    const record = await w.store.get(`swap:${id}`);
    // Nothing left to fund another swap: the page's own stays unfunded.
    w.chain.utxos.clear();
    const store = await beside(w, record, { taken: false });
    const resume = vi.spyOn(Buyer, 'resume');
    try {
      render(<App config={{ ...w.config, driver: { ...w.config.driver, store } }} />);
      await screen.findByRole('heading', { name: 'Fund your wallet' }, WAIT);
      tab(/^Settings/);
      upload(file);
      await screen.findByText('Lock your BTC', {}, WAIT);
      // The swap left behind: a status it sends now is not shown.
      const left = (await resume.mock.results[0].value) as Buyer;
      expect(left.swapId).toBe('ff'.repeat(32));
      // Checked as soon as it renders: the followed swap's next status would
      // cover it.
      await act(() => {
        left.dispatchEvent(new CustomEvent('status', { detail: left.status() }));
      });
      expect(screen.queryByRole('heading', { name: 'Fund your wallet' })).toBeNull();
      expect(screen.getByText('Lock your BTC')).toBeTruthy();
    } finally {
      resume.mockRestore();
    }
  });

  test('a restore whose swap would run beside the page’s says so plainly', async () => {
    const w = await world();
    const { file } = await funded(w);
    const record = await w.store.get(`swap:${JSON.parse(w.offer).template.swap_id}`);
    const store = await beside(w, record, {});
    render(<App config={{ ...w.config, driver: { ...w.config.driver, store } }} />);
    await screen.findByText('Lock your BTC', {}, WAIT);
    tab(/^Settings/);
    upload(file);
    await screen.findByText(
      'Not restored: this file holds a running swap, and this browser runs another. One swap at a time: restore it once that one ends.',
      {},
      WAIT,
    );
  });

  test('a browser holding another wallet refuses the file', async () => {
    const w = await world();
    const { file } = await funded(w);
    const other = new MemoryStore();
    await Wallet.open(driverOf(w, { store: other }));
    render(<App config={{ ...w.config, driver: { ...w.config.driver, store: other } }} />);
    tab(/^Settings/);
    upload(file);
    await screen.findByText('refused: the store holds another wallet', {}, WAIT);
  });
});

describe('settings', () => {
  /** The saved settings: a store of the test's own, as Node's
   * `localStorage` stands over jsdom's where it has one. */
  const kept = new Map<string, string>();
  const saved = (name: string) => kept.get(`lattice-swap:regtest:${name}`) ?? null;
  const reload = vi.fn();
  const store = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => kept.set(key, value),
    removeItem: (key: string) => kept.delete(key),
  };
  /** Settings over `w`, a reload only noted, once `ready` shows; the page
   * served over `protocol`. */
  async function settings(w: World, config = w.config, ready?: string, protocol = location.protocol) {
    vi.stubGlobal('localStorage', store);
    vi.stubGlobal('location', { ...location, protocol, reload });
    render(<App config={config} />);
    if (ready !== undefined) await screen.findByText(ready, {}, WAIT);
    tab(/^Settings/);
  }
  const set = (label: string, value: string) => fireEvent.input(screen.getByLabelText(label), { target: { value } });
  /** A server of the test's, closed with the rest. */
  async function server<T extends { close: () => void }>(made: Promise<T>): Promise<T> {
    const s = await made;
    servers.push(s);
    return s;
  }
  afterEach(() => {
    kept.clear();
    reload.mockClear();
    vi.unstubAllGlobals();
  });

  test('the servers in use are checked as Settings opens: public and reachable, or why not', async () => {
    const w = await world();
    await settings(w);
    await waitFor(() => expect(screen.getAllByText('Reachable.')).toHaveLength(2), WAIT);
    expect(screen.getByText(`Public (${new URL(w.config.esplora).host})`)).toBeTruthy();
    expect(screen.getByText(`Public (${new URL(w.config.nexus).host})`)).toBeTruthy();
    cleanup();

    const down = await server(nexus({ down: true }));
    await settings(w, { ...w.config, nexus: down.url });
    expect(screen.getByText('Your node')).toBeTruthy();
    await screen.findByText(/^Unreachable: .*\/api\/chain\/info: 503 down$/, {}, WAIT);
  });

  test('a server the driver refuses is not saved, with its reason', async () => {
    const w = await world();
    const signet = new Chain();
    signet.genesis = '00'.repeat(32);
    const wrong = await server(esplora(signet));
    const readOnly = await server(nexus({ acceptsSubmit: false }));
    const otherNexus = await server(nexus({ genesis: 'other' }));
    await settings(w);
    set('Bitcoin backend (Esplora)', wrong.url);
    click('Save and reload');
    await screen.findByText(/^Not saved: refused: the Esplora's genesis is 0{64}, not regtest's /, {}, WAIT);
    set('Bitcoin backend (Esplora)', w.config.esplora);
    set('Nexus read URL', readOnly.url);
    click('Save and reload');
    await screen.findByText(`Not saved: refused: ${readOnly.url} takes no transactions: give a Nexus node that does`, {}, WAIT);
    set('Nexus read URL', otherNexus.url);
    click('Save and reload');
    await screen.findByText(/^Not saved: refused: .*genesis/, {}, WAIT);
    // Refused on what it answered, not unreachable: a node that keeps no
    // state of past blocks, and an answer not a Nexus node's.
    const noPast = await server(nexus({ height: '10' }));
    set('Nexus read URL', noPast.url);
    click('Save and reload');
    await screen.findByText(/^Not saved: refused: the Nexus node keeps no state of past blocks/, {}, WAIT);
    const odd = await server(
      serve((_method: string, path: string) =>
        path === '/health'
          ? [200, { phase: 'active', height: '1', tipCID: 'tip' }]
          : [200, { chain: ['Nexus'], acceptsSubmit: true, height: '1', tipCID: 'tip' }],
      ),
    );
    set('Nexus read URL', odd.url);
    click('Save and reload');
    await screen.findByText(/^Not saved: refused: unexpected node answer: /, {}, WAIT);
    expect(saved('esplora')).toBeNull();
    expect(saved('nexus')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  test('a server of your own that passes is saved; going back to public clears it', async () => {
    const w = await world();
    const own = await server(nexus());
    await settings(w);
    set('Nexus read URL', own.url);
    click('Save and reload');
    await waitFor(() => expect(reload).toHaveBeenCalledOnce(), WAIT);
    expect(saved('nexus')).toBe(own.url);
    // The public one typed in again is the public one: nothing kept.
    expect(saved('esplora')).toBeNull();
    cleanup();

    await settings(w, { ...w.config, nexus: own.url });
    click(`Use the public node (${new URL(w.config.nexus).host})`);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2), WAIT);
    expect(saved('nexus')).toBeNull();
  });

  test("a running swap's servers can be changed once the checks pass: it carries on with them", async () => {
    const w = await world();
    const wallet = await Wallet.open(driverOf(w));
    const buyer = await Buyer.prepare(wallet, { offer: w.offer, policy: POLICY, nexAddress: w.nexAddress });
    deposit(w, wallet.address, 1_100_000);
    const stop = new AbortController();
    const done = buyer.run(stop.signal);
    await until(() => posted(w).length === 1, 20_000);
    stop.abort();
    await done;
    const own = await server(nexus());
    const down = await server(nexus({ down: true }));
    // The page resumes the swap: its wallet is open.
    await settings(w, w.config, 'Lock your BTC');
    await screen.findByText('A swap is running: it carries on with the servers you save.', {}, WAIT);
    // Still checked first.
    set('Nexus read URL', down.url);
    click('Save and reload');
    await screen.findByText(/^Not saved: Unreachable: .*503 down$/, {}, WAIT);
    set('Nexus read URL', own.url);
    click('Save and reload');
    await waitFor(() => expect(reload).toHaveBeenCalledOnce(), WAIT);
    expect(saved('nexus')).toBe(own.url);
  });

  test('a page served over https takes no plain http server of your own, and asks it nothing', async () => {
    const w = await world();
    const paths: string[] = [];
    const own = await server(nexus({ paths }));
    await settings(w, w.config, undefined, 'https:');
    set('Nexus read URL', own.url);
    click('Save and reload');
    await screen.findByText('Not saved: refused: must be an https URL', {}, WAIT);
    expect(paths).toEqual([]);
    expect(saved('nexus')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  test('the public server written another way is the public one: nothing kept, on save or on load', async () => {
    const w = await world();
    const own = await server(nexus());
    await settings(w, { ...w.config, nexus: own.url });
    set('Nexus read URL', `${w.config.nexus.replace('http:', 'HTTP:')}/`);
    click('Save and reload');
    await waitFor(() => expect(reload).toHaveBeenCalledOnce(), WAIT);
    expect(saved('nexus')).toBeNull();
    cleanup();

    // An older page kept the public one itself.
    vi.stubEnv('VITE_NETWORK', 'regtest');
    vi.stubEnv('VITE_ESPLORA', 'https://esplora.example/api');
    vi.stubEnv('VITE_NEXUS', 'https://nexus.example');
    vi.stubGlobal('localStorage', store);
    kept.set('lattice-swap:regtest:esplora', 'https://ESPLORA.example/api/');
    kept.set('lattice-swap:regtest:nexus', 'https://own.example');
    const config = buildConfig();
    expect(config.esplora).toBe('https://esplora.example/api');
    expect(config.nexus).toBe('https://own.example');
    vi.unstubAllEnvs();
  });

  test('a relay added is checked first, and kept; the list is read back on load, and may be empty', async () => {
    const w = await world();
    const [relay] = w.config.relays;
    const added = await relayOf([]);
    const down = await server(serve(() => [503, 'down']));
    await settings(w);
    set('Relays', down.url);
    click('Add relay');
    click('Save and reload');
    await screen.findByText(`Not saved: ${down.url}: Unreachable: ${down.url}/offers: 503`, {}, WAIT);
    click(`Remove ${down.url}`);
    set('Relays', added.url);
    click('Add relay');
    click('Save and reload');
    await waitFor(() => expect(reload).toHaveBeenCalledOnce(), WAIT);
    expect(saved('relays')).toBe(JSON.stringify([relay, added.url]));
    vi.stubEnv('VITE_NETWORK', 'regtest');
    vi.stubEnv('VITE_RELAY', relay);
    expect(buildConfig().relays).toEqual([relay, added.url]);
    cleanup();

    // None at all is kept as none, not the build's.
    await settings(w, { ...w.config, relays: [relay, added.url] });
    click(`Remove ${relay}`);
    click(`Remove ${added.url}`);
    expect(screen.getByText('None: no offers are listed.')).toBeTruthy();
    click('Save and reload');
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2), WAIT);
    expect(saved('relays')).toBe('[]');
    expect(buildConfig().relays).toEqual([]);
    cleanup();

    // The build's alone again: nothing kept.
    await settings(w, { ...w.config, relays: [] });
    set('Relays', relay);
    click('Add relay');
    click('Save and reload');
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(3), WAIT);
    expect(saved('relays')).toBeNull();
    expect(buildConfig().relays).toEqual([relay]);
    vi.unstubAllEnvs();
  });

  test('a relay list kept holds only relay URLs, each server once; one not a URL is not added', async () => {
    vi.stubGlobal('localStorage', store);
    vi.stubEnv('VITE_NETWORK', 'regtest');
    kept.set('lattice-swap:regtest:relays', JSON.stringify(['https://a.example', 'HTTPS://A.example/', 'ftp://b.example', 'not a url', 7, 'http://c.example']));
    expect(buildConfig().relays).toEqual(['https://a.example', 'http://c.example']);
    vi.unstubAllEnvs();

    const w = await world();
    await settings(w);
    set('Relays', 'ftp://b.example');
    click('Add relay');
    expect(screen.getByText("Not added: ftp://b.example is not a relay's URL (https://…)")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove ftp://b.example' })).toBeNull();
  });

  test('a relay directory is read before it is saved, of the chain typed, and read back on load', async () => {
    const node = 'https://dir.example';
    const chain = new DirectoryChain();
    const tip = chain.block([[`relay/${call('newNexKey').address}`, 'https://r.example']]);
    const realFetch = globalThis.fetch;
    const w = await world();
    await settings(w);
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith(node) ? Promise.resolve(chain.answer(String(input), tip)) : realFetch(input, init),
    );
    set('Relay directory', node);
    click('Save and reload');
    await screen.findByText('Not saved: relay directory: name the chain of the directory, as Nexus/testnet/swap-relays', {}, WAIT);
    set('Its chain', 'Nexus/other');
    click('Save and reload');
    await screen.findByText('Not saved: relay directory: refused: the node answered for another chain than Nexus/other', {}, WAIT);
    set('Its chain', 'Nexus/testnet/swap-relays');
    click('Save and reload');
    await waitFor(() => expect(reload).toHaveBeenCalledOnce(), WAIT);
    expect(saved('directory')).toBe(JSON.stringify({ node, chain: 'Nexus/testnet/swap-relays' }));
    vi.stubEnv('VITE_NETWORK', 'regtest');
    expect(buildConfig().directory).toEqual({ node, chain: 'Nexus/testnet/swap-relays' });

    // Turned off on a build that sets one: kept as none, not the build's.
    const directory = { node, chain: 'Nexus/testnet/swap-relays' };
    vi.stubEnv('VITE_RELAY_DIRECTORY', node);
    vi.stubEnv('VITE_RELAY_DIRECTORY_CHAIN', directory.chain);
    cleanup();
    await settings(w, { ...w.config, directory, defaults: { ...w.config.defaults, directory } });
    set('Relay directory', '');
    click('Save and reload');
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2), WAIT);
    expect(saved('directory')).toBe(JSON.stringify({ node: '', chain: '' }));
    expect(buildConfig().directory).toEqual({ node: '', chain: '' });
    vi.unstubAllEnvs();
  });

  test('a browser that keeps no settings saves nothing, says so, and does not reload', async () => {
    const w = await world();
    const own = await server(nexus());
    await settings(w);
    const refuse = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: refuse, removeItem: refuse });
    set('Nexus read URL', own.url);
    click('Save and reload');
    await screen.findByText('Not saved: this browser keeps no settings (private mode?)', {}, WAIT);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save and reload' }).hasAttribute('disabled')).toBe(false);
  });
});

describe('several relays', () => {
  /** Another seller's offer, cheaper than the test offer: 0.01 BTC a NEX. */
  const cheaper = (offer: string) => signedOffer(offer, '{"price":1000000,"min_btc_amount":10000,"max_btc_amount":1000000}');
  const host = (url: string) => new URL(url).host;
  /** Each row's price and relay. */
  const rows = () => [...document.querySelectorAll('tbody tr')].map((tr) => [(tr as HTMLTableRowElement).cells[0].textContent, (tr as HTMLTableRowElement).cells[3].textContent]);

  test('every relay’s offers, merged best first; one down or slow holds back none, and the one down is named', async () => {
    const w = await world();
    const listed: string[] = [];
    const b = await relayOf(listed);
    // A copy of the test offer on b names w's relay: not b's to list.
    listed.push(cheaper(naming(w.offer, b.url)), w.offer);
    let answer = () => {};
    const slow = await serve(() => new Promise((resolve) => (answer = () => resolve([200, []]))));
    const down = await serve(() => [503, 'down']);
    servers.push(slow, down);
    try {
      render(<App config={{ ...w.config, relays: [slow.url, w.config.relays[0], down.url, b.url] }} />);
      tab(/^Offers/);
      await screen.findByText(`Could not read the offers of ${host(down.url)}: ${down.url}/offers: 503`, {}, WAIT);
      await waitFor(() => expect(rows()).toEqual([['0.01000000 BTC', host(b.url)], ['0.02000000 BTC', host(w.config.relays[0])]]), WAIT);
    } finally {
      answer();
    }
  });

  test('a relay listing without end has only its first entries read', async () => {
    const w = await world();
    const [relay] = w.config.relays;
    w.listed.unshift(...Array<string>(MAX_OFFERS - 1).fill('{}'));
    expect((await listOffers(relay, 'regtest', 'genesis')).map((l) => l.text)).toEqual([w.offer]);
    w.listed.unshift('{}');
    expect(await listOffers(relay, 'regtest', 'genesis')).toEqual([]);
  });

  test('an earlier refresh answered last does not undo a later one', async () => {
    const w = await world();
    // The first read held until the second has answered, with none.
    let first = () => {};
    let reads = 0;
    const late = await serve(() => (++reads === 1 ? new Promise((resolve) => (first = () => resolve([200, [JSON.parse(naming(w.offer, late.url))]]))) : [200, []]));
    servers.push(late);
    render(<App config={{ ...w.config, relays: [late.url] }} />);
    await until(() => reads === 1);
    tab(/^Offers/);
    await screen.findByText('No offers on the relays right now.', {}, WAIT);
    first();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(document.querySelector('table')).toBeNull();
    expect(screen.getByText('No offers on the relays right now.')).toBeTruthy();
  });

  test('an offer is taken through the relay it is listed on', async () => {
    const w = await world();
    const listed: string[] = [];
    const b = await relayOf(listed);
    // The test offer on b too, naming b, under one cheaper on w's relay.
    listed.push(naming(w.offer, b.url));
    w.listed.push(cheaper(w.offer));
    const through: string[] = [];
    const driver = {
      ...w.config.driver,
      openSession: (offer: { relay: string }, ...rest: unknown[]) => {
        through.push(offer.relay);
        return w.seller.open(offer, ...rest);
      },
    };
    render(<App config={{ ...w.config, relays: [w.config.relays[0], b.url], driver }} />);
    tab(/^Offers/);
    await waitFor(() => expect(rows()).toHaveLength(3), WAIT);
    const row = [...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent!.includes(host(b.url)))!;
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Swap' }));
    fireEvent.click(await screen.findByText(/your pick/, {}, WAIT));
    expect(screen.getByText('Relay').nextSibling?.textContent).toBe(host(b.url));
    fireEvent.input(screen.getByLabelText('You pay'), { target: { value: '0.01' } });
    fireEvent.input(screen.getByLabelText('Send NEX to'), { target: { value: w.nexAddress } });
    click('Swap');
    await screen.findByRole('heading', { name: 'Review swap' }, WAIT);
    click('Start swap');
    await screen.findByRole('heading', { name: 'Fund your wallet' }, WAIT);
    deposit(w, (await Wallet.open(driverOf(w))).address as string, 1_100_000);
    await until(() => through.length > 0, 20_000);
    expect(through).toEqual([b.url]);
  });

  describe('found on a relay directory', () => {
    const DIR = 'https://dir.example';
    const CHAIN = 'Nexus/testnet/swap-relays';
    const realFetch = globalThis.fetch;
    const account = () => call('newNexKey').address as string;
    /** The page's fetch: the directory's node at DIR answering as
     * `answer`, each https server of `hosts` at the test server it names,
     * any other as it is. */
    function route(answer: (url: string) => Response, hosts: Record<string, string> = {}) {
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith(DIR)) return Promise.resolve(answer(url));
        const from = Object.keys(hosts).find((h) => url.startsWith(h));
        return from === undefined ? realFetch(input, init) : realFetch(hosts[from] + url.slice(from.length), init);
      });
    }
    afterEach(() => vi.unstubAllGlobals());

    test('lists the relays at the tip, asking for each node once, in the order the listing wants them', async () => {
      // Two pairs of accounts, each pair sharing the character past what
      // every address shares: the trie holds two nodes side by side, each
      // with children of its own, which only a depth-first read takes
      // one after the other's children.
      const by = new Map<string, string[]>();
      let pairs: string[][] = [];
      while (pairs.length < 2) {
        const a = account();
        by.set(a[7], [...(by.get(a[7]) ?? []), a]);
        pairs = [...by.values()].filter((group) => group.length >= 2);
      }
      const accounts = pairs.flatMap((group) => group.slice(0, 2));
      const chain = new DirectoryChain();
      const tip = chain.block(accounts.map((a, i) => [`relay/${a}`, `https://r${i}.example`]));
      // One node an answer, so the nodes asked for are the nodes given, in
      // order.
      const asked: string[] = [];
      const read = await readDirectory({ node: DIR, chain: CHAIN }, async (url) => chain.answer(String(url), tip, { asked, perBatch: 1 }));
      expect(read.partial).toBeNull();
      expect(read.relays.sort()).toEqual(accounts.map((_, i) => `https://r${i}.example/`));
      expect(asked).toHaveLength(chain.nodes.size);
      expect(new Set(asked).size).toBe(asked.length);
      asked.forEach((cid, i) => {
        const links = chain.below.get(cid)!;
        if (links.length > 0 && i + 1 < asked.length) expect(links).toContain(asked[i + 1]);
      });
    });

    test('a node answering for another chain is refused, and asked nothing more', async () => {
      const chain = new DirectoryChain();
      const tip = chain.block([[`relay/${account()}`, 'https://r.example']]);
      const asked: string[] = [];
      const read = readDirectory({ node: DIR, chain: CHAIN }, async (url) => chain.answer(String(url), tip, { chain: ['Nexus', 'other'], asked }));
      await expect(read).rejects.toThrow(`the node answered for another chain than ${CHAIN}`);
      expect(asked).toEqual([]);
    });

    /** A directory of `n` relays, `https://r<i>.example`. */
    function many(n: number) {
      const chain = new DirectoryChain();
      const tip = chain.block(Array.from({ length: n }, (_, i): [string, string] => [`relay/${account()}`, `https://r${i}.example`]));
      return { chain, tip, urls: Array.from({ length: n }, (_, i) => `https://r${i}.example/`).sort() };
    }

    test('a node that rate-limits its Volume reads is read in batches, waited on past its burst', async () => {
      const { chain, tip, urls } = many(40);
      // A public read port's Volume limit, scaled down: a burst of 3,
      // then one a second, refused with 429.
      let tokens = 3;
      let last = Date.now();
      let reads = 0;
      let refused = 0;
      const read = await readDirectory({ node: DIR, chain: CHAIN }, async (url) => {
        if (!new URL(String(url)).pathname.startsWith('/volumes')) return chain.answer(String(url), tip);
        tokens = Math.min(3, tokens + (Date.now() - last) / 1000);
        last = Date.now();
        if (tokens < 1) return (refused++, new Response('', { status: 429 }));
        tokens--;
        reads++;
        return chain.answer(String(url), tip);
      });
      expect(read).toEqual({ relays: expect.any(Array), partial: null });
      expect(read.relays.sort()).toEqual(urls);
      expect(refused).toBeGreaterThan(0);
      // A request a level of the trie, not a node: within a public port's
      // burst of 10.
      expect(reads).toBeLessThanOrEqual(10);
    });

    test('no node is asked for twice, however wide the directory', async () => {
      const { chain, tip, urls } = many(300);
      const asked: string[] = [];
      const read = await readDirectory({ node: DIR, chain: CHAIN }, async (url) => chain.answer(String(url), tip, { asked }));
      expect(read.relays.sort()).toEqual(urls);
      expect(asked).toHaveLength(chain.nodes.size);
      expect(new Set(asked).size).toBe(asked.length);
    });

    test('a link that is no CID is never asked for; the relays read before it are kept', async () => {
      const chain = new DirectoryChain();
      const entry = chain.put({ prefix: `relay/${account()}`, value: 'https://r.example', children: [{ key: 'x', value: { rawCID: 'not a/cid' } }] });
      const tip = chain.commit([{ key: 'r', value: { rawCID: entry } }], [entry]);
      const answers: number[] = [];
      const read = await readDirectory({ node: DIR, chain: CHAIN }, async (url) => {
        const answer = chain.answer(String(url), tip);
        answers.push(answer.status);
        return answer;
      });
      expect(read).toEqual({ relays: ['https://r.example/'], partial: 'not a/cid is not a CID' });
      expect(answers.every((status) => status === 200)).toBe(true);
    });

    test('a node without the many-Volume read is read a Volume at a time; one that says when to come back is waited on', async () => {
      const { chain, tip, urls } = many(10);
      let busy = true;
      const read = await readDirectory({ node: DIR, chain: CHAIN }, async (url) => {
        const { pathname } = new URL(String(url));
        if (pathname === '/volumes') return new Response('not found', { status: 404 });
        if (pathname.startsWith('/volumes/') && busy) {
          busy = false;
          return new Response('busy', { status: 503, headers: { 'Retry-After': '1' } });
        }
        return chain.answer(String(url), tip);
      });
      expect(read).toEqual({ relays: expect.any(Array), partial: null });
      expect(read.relays.sort()).toEqual(urls);
      expect(busy).toBe(false);
    });

    test('a read cut short keeps the relays listed by then, as partial; one that lists none fails', async () => {
      const { chain, tip } = many(10);
      let reads = 0;
      const after = (n: number) => async (url: RequestInfo | URL) =>
        new URL(String(url)).pathname.startsWith('/volumes') && ++reads > n
          ? new Response('down', { status: 503 })
          : chain.answer(String(url), tip, { perBatch: 1 });
      const read = await readDirectory({ node: DIR, chain: CHAIN }, after(chain.nodes.size - 2));
      expect(read.relays.length).toBeGreaterThan(0);
      expect(read.relays.length).toBeLessThan(10);
      expect(read.partial).toBe(`${DIR}/volumes: 503`);
      reads = 0;
      await expect(readDirectory({ node: DIR, chain: CHAIN }, after(2))).rejects.toThrow(`${DIR}/volumes: 503`);
    });

    test('an answer past its cap is not read', async () => {
      const big = async () => new Response(new Uint8Array(MAX_DIRECTORY_BYTES + 1));
      await expect(readDirectory({ node: DIR, chain: CHAIN }, big)).rejects.toThrow(`an answer over ${MAX_DIRECTORY_BYTES} bytes`);
      const relay = await serve(() => [200, 'x'.repeat(MAX_FOUND_RELAY_BYTES + 1)]);
      servers.push(relay);
      await expect(listOffers(relay.url, 'regtest', 'genesis', MAX_FOUND_RELAY_BYTES)).rejects.toThrow(`an answer over ${MAX_FOUND_RELAY_BYTES} bytes`);
      // A relay of your own may list more.
      await expect(listOffers(relay.url, 'regtest', 'genesis')).rejects.toThrow(/JSON/);
    });

    test('found relays are read beside your own: not yours again, each server once, at most the cap', () => {
      const own = ['https://own.example'];
      const found = ['https://OWN.example/', 'https://a.example', 'https://a.example/'];
      for (let i = 0; i < 20; i++) found.push(`https://r${i}.example`);
      const picked = pickFound(own, found);
      expect(picked).toHaveLength(MAX_DIRECTORY_RELAYS);
      expect(new Set(picked).size).toBe(picked.length);
      expect(picked.some((url) => url.toLowerCase().includes('own.example'))).toBe(false);
      expect(pickFound(own, found.slice(0, 3))).toEqual(['https://a.example']);
    });

    test('a found relay’s offers are listed beside your own, as via the directory', async () => {
      const w = await world();
      const found = await relayOf([cheaper(naming(w.offer, 'https://found.example'))]);
      const chain = new DirectoryChain();
      const tip = chain.block([[`relay/${account()}`, 'https://found.example']]);
      route((url) => chain.answer(url, tip), { 'https://found.example': found.url });
      render(<App config={{ ...w.config, directory: { node: DIR, chain: CHAIN } }} />);
      tab(/^Offers/);
      await waitFor(
        () =>
          expect(rows()).toEqual([
            ['0.01000000 BTC', 'found.example · via directory'],
            ['0.02000000 BTC', host(w.config.relays[0])],
          ]),
        WAIT,
      );
    });

    test('a directory that cannot be read is noted, and your own relays are listed', async () => {
      const w = await world();
      route(() => new Response('down', { status: 503 }));
      render(<App config={{ ...w.config, directory: { node: DIR, chain: CHAIN } }} />);
      tab(/^Offers/);
      await screen.findByText(`Could not read the relay directory: ${DIR}/api/chain/info: 503`, {}, WAIT);
      await waitFor(() => expect(rows()).toEqual([['0.02000000 BTC', host(w.config.relays[0])]]), WAIT);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText('No relay configured')).toBeNull();
    });

    test('a directory that failed is read again on a refresh only once a minute has passed', async () => {
      const w = await world();
      let infos = 0;
      route((url) => (url.includes('/api/chain/info') && infos++, new Response('down', { status: 503 })));
      render(<App config={{ ...w.config, directory: { node: DIR, chain: CHAIN } }} />);
      await screen.findByText(`Could not read the relay directory: ${DIR}/api/chain/info: 503`, {}, WAIT);
      tab(/^Offers/);
      tab(/^Swap/);
      tab(/^Offers/);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(infos).toBe(1);
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + DIRECTORY_RETRY);
      try {
        tab(/^Swap/);
        await until(() => infos === 2);
      } finally {
        clock.mockRestore();
      }
    });

    test('with no relays of your own and a directory that cannot be read, the page says how to add one', async () => {
      const w = await world({ relay: false });
      route(() => new Response('down', { status: 503 }));
      render(<App config={{ ...w.config, directory: { node: DIR, chain: CHAIN } }} />);
      expect(screen.queryByText('No relay configured')).toBeNull();
      await screen.findByText('No relay configured', {}, WAIT);
      expect(screen.getByText(`Could not read the relay directory: ${DIR}/api/chain/info: 503`)).toBeTruthy();
    });

    test('a found relay that fails has its offers dropped, and is not named', async () => {
      const w = await world();
      let up = true;
      const offer = JSON.parse(cheaper(naming(w.offer, 'https://found.example')));
      const found = await serve((_method: string, path: string) => (path !== '/offers' ? undefined : up ? [200, [offer]] : [503, 'down']));
      servers.push(found);
      const chain = new DirectoryChain();
      const tip = chain.block([[`relay/${account()}`, 'https://found.example']]);
      route((url) => chain.answer(url, tip), { 'https://found.example': found.url });
      render(<App config={{ ...w.config, directory: { node: DIR, chain: CHAIN } }} />);
      tab(/^Offers/);
      await waitFor(() => expect(rows()).toHaveLength(2), WAIT);
      up = false;
      tab(/^Swap/);
      tab(/^Offers/);
      await waitFor(() => expect(rows()).toEqual([['0.02000000 BTC', host(w.config.relays[0])]]), WAIT);
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});

test('a restore that waited on another tab carries on in this one once it closes', async () => {
  const w = await world();
  const wallet = await Wallet.open(driverOf(w));
  const buyer = await Buyer.prepare(wallet, { offer: w.offer, policy: POLICY, nexAddress: w.nexAddress });
  deposit(w, wallet.address, 1_100_000);
  const stop = new AbortController();
  const done = buyer.run(stop.signal);
  await until(() => posted(w).length === 1, 20_000);
  stop.abort();
  await done;
  const file = (await wallet.backup()).file as string;

  const locks = new Locks();
  const first = locks.tab();
  const fresh = new MemoryStore();
  render(<App config={{ ...w.config, driver: { ...w.config.driver, store: fresh, locks: locks.tab() } }} />);
  // Another tab takes the lock before the restore.
  await Wallet.open(driverOf(w, { store: new MemoryStore(), locks: first }));
  tab(/^Settings/);
  fireEvent.change(screen.getByLabelText('Restore from file'), {
    target: { files: [new File([file], 'backup.json', { type: 'application/json' })] },
  });
  await screen.findByText('Lattice Swap is open in another tab', {}, WAIT);
  locks.close(first);
  await screen.findByText('Lock your BTC', {}, WAIT);
  expect(screen.queryByText('Lattice Swap is open in another tab')).toBeNull();
});

test('a second tab waits, then carries on once the first closes', async () => {
  const w = await world();
  const locks = new Locks();
  const first = locks.tab();
  await Wallet.open(driverOf(w, { locks: first }));
  render(<App config={{ ...w.config, driver: { ...w.config.driver, locks: locks.tab() } }} />);
  await screen.findByText('Lattice Swap is open in another tab', {}, WAIT);
  expect(screen.queryByLabelText('You pay')).toBeNull();
  locks.close(first);
  await screen.findByLabelText('You pay', {}, WAIT);
  expect(screen.queryByText('Lattice Swap is open in another tab')).toBeNull();
});

test('a build with no relay says so', async () => {
  const w = await world({ relay: false });
  render(<App config={w.config} />);
  expect(screen.getByText('No relay configured')).toBeTruthy();
  tab(/^Offers/);
  expect(screen.getByText('No relay configured')).toBeTruthy();
});

describe('persistent storage', () => {
  const NOTICE = "This browser may clear this wallet's data. Download the recovery file.";
  const stub = (storage: object | undefined) => vi.stubGlobal('navigator', { ...navigator, storage });
  const apis = (persisted: boolean, granted: boolean) => ({
    persisted: vi.fn(async () => persisted),
    persist: vi.fn(async () => granted),
  });

  test('none asked on load; asked once a swap is prepared, and a refusal shows the notice', async () => {
    const storage = apis(false, false);
    stub(storage);
    try {
      const w = await world();
      render(<App config={w.config} />);
      await screen.findByText(/best of 1/, {}, WAIT);
      expect(storage.persist).not.toHaveBeenCalled();
      cleanup();
      await startSwap(w);
      expect(storage.persist).toHaveBeenCalled();
      await screen.findByText(NOTICE, {}, WAIT);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('asked once a wallet is made; granted, no notice', async () => {
    const storage = apis(false, true);
    stub(storage);
    try {
      const w = await world();
      render(<App config={w.config} />);
      await screen.findByText(/best of 1/, {}, WAIT);
      tab(/^Wallet/);
      click('Make a wallet');
      await screen.findByText('Withdraw everything to', {}, WAIT);
      await waitFor(() => expect(storage.persist).toHaveBeenCalled(), WAIT);
      await act(async () => {});
      expect(screen.queryByText(NOTICE)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('already persisted: not asked again, no notice', async () => {
    const storage = apis(true, false);
    stub(storage);
    try {
      const w = await world();
      await startSwap(w);
      await waitFor(() => expect(storage.persisted).toHaveBeenCalled(), WAIT);
      await act(async () => {});
      expect(storage.persist).not.toHaveBeenCalled();
      expect(screen.queryByText(NOTICE)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a page loaded over a wallet asks, and a refusal shows the notice', async () => {
    const storage = apis(false, false);
    stub(storage);
    try {
      const w = await world();
      await Wallet.open(driverOf(w));
      render(<App config={w.config} />);
      await screen.findByText(/best of 1/, {}, WAIT);
      await waitFor(() => expect(storage.persist).toHaveBeenCalled(), WAIT);
      tab(/^Wallet/);
      await screen.findByText(NOTICE, {}, WAIT);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a browser without the API still makes a wallet and starts a swap', async () => {
    stub(undefined);
    try {
      const w = await world();
      await startSwap(w);
      expect(screen.queryByText(NOTICE)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('a punished swap', () => {
  /** What the seller broadcasts on `event`. */
  function sellerSees(w: World, event: unknown): string[] {
    const { actions } = call('stepSeller', w.seller.state(), JSON.stringify(event));
    w.seller.step(event);
    return actions.filter((action: { Broadcast?: string }) => action.Broadcast).map((action: { Broadcast: string }) => action.Broadcast);
  }

  /** A swap the seller punished, as the driver's own test plays it: the
   * buyer's page closed once its lock was out, the seller locked NEX,
   * cancelled at t1 and punished t2 later, and the buyer, back to the
   * punish deep, met no seller and ended punished. A copy of the swap as
   * prepared, untaken, waits ahead of it in the store, as swap 00…00. The
   * seller has not seen its punish deep, and is nowhere to be met. Its
   * quiet times out on `clock`, moved past the message timeout, as the
   * driver's own test does: never on the wall clock, which a slow runner
   * spends on the fake seller's wasm. */
  async function punished(w: World, clock: { offset: number }) {
    const { t1, t2 } = JSON.parse(w.offer).template;
    const wallet = await Wallet.open(driverOf(w));
    const buyer = await Buyer.prepare(wallet, { offer: w.offer, policy: POLICY, nexAddress: w.nexAddress });
    const key = `swap:${buyer.swapId}`;
    const prepared = await w.store.get(key);
    deposit(w, wallet.address, 1_100_000);
    const stop = new AbortController();
    const done = buyer.run(stop.signal);
    await until(() => posted(w).length === 1, 20_000);
    stop.abort();
    await done;

    confirm(w, posted(w)[0]);
    w.seller.step({ Bitcoin: { height: w.chain.height, funding: 1, lock_spend: null, cancel_spend: null, stale: null } });
    const health = { phase: 'active', height: 10, best_header_height: 10, tip: 'tip' };
    const nexus = (watched: unknown) => ({
      Nexus: { health, own: { balance: 10_000_000, nonce: 3 }, lock: { balance: 0, nonce: 0 }, min_relay_fee: 0, watched, block_at: null },
    });
    w.seller.step(nexus(null));
    const { body } = JSON.parse(w.seller.state()).LockingNex.nex_lock;
    w.seller.step(nexus([{ body, block: { height: 10, hash: 'tip' } }, 1]));
    const lockHeight = w.chain.height;
    const bitcoin = (lockSpend: unknown, cancelSpend: unknown) => ({
      Bitcoin: { height: w.chain.height, funding: w.chain.height - lockHeight + 1, lock_spend: lockSpend, cancel_spend: cancelSpend, stale: null },
    });
    w.chain.mine(t1 - 1);
    const [cancel] = sellerSees(w, bitcoin(null, null));
    confirm(w, cancel);
    w.chain.mine(t2 - 1);
    const [punish] = sellerSees(w, bitcoin({ tx: cancel, confirmations: t2 }, null));
    confirm(w, punish);
    // Moved on until it ends: one move could land between the driver
    // saving a state and restarting its timer, which then counts from it.
    let outcome: string | null = null;
    const resumed = (await Buyer.resume(wallet, buyer.swapId)).run().then((ended: string | null) => (outcome = ended ?? 'none'));
    await until(() => {
      clock.offset += 61_000;
      return outcome !== null;
    }, 20_000);
    expect(await resumed).toBe('punished');

    const record = await w.store.get(key);
    await w.store.delete(key);
    const other = '00'.repeat(32);
    await w.store.put(`swap:${other}`, { ...prepared, swap_id: other });
    await w.store.put(key, record);
    expect(await w.store.keys()).toEqual(['wallet', `swap:${other}`, key]);
    /** The seller sees its punish deep: punished in its own eyes, it waits
     * at its rendezvous to give `s`. */
    const sellerPunished = () => sellerSees(w, bitcoin({ tx: cancel, confirmations: t2 + 1 }, { tx: punish, confirmations: 1 }));
    return { key, sellerPunished };
  }

  const asks = (w: World) => w.seller.log.filter((message: unknown) => message === 'ShareRequest').length;
  const ASKING = 'Asking the seller to release your NEX…';

  /** A world whose driver reads time off `clock`. */
  async function clocked() {
    const clock = { offset: 0 };
    const w = await world({ extra: { now: () => Date.now() + clock.offset } });
    return { w, clock };
  }

  test('a load asks the seller for s once, and claims the NEX with it', async () => {
    const { w, clock } = await clocked();
    const { key, sellerPunished } = await punished(w, clock);
    sellerPunished();
    render(<App config={w.config} />);
    await screen.findByText(ASKING, {}, WAIT);
    // Not the swap waiting for funds ahead of it, and not shown as running.
    expect(screen.queryByRole('heading', { name: 'Fund your wallet' })).toBeNull();
    tab(/^Wallet/);
    expect(within(screen.getByRole('banner')).getByRole('button', { name: /^Swap · / }).textContent).toBe('Swap · asking the seller');
    await until(async () => Object.keys(JSON.parse((await w.store.get(key)).state))[0] === 'ClaimingNex', 20_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(asks(w)).toBe(1);
  });

  test('a seller not met leaves it punished, said so, and the page asks no more this load', async () => {
    const { w, clock } = await clocked();
    const { key } = await punished(w, clock);
    const resume = vi.spyOn(Buyer, 'resume');
    try {
      render(<App config={w.config} />);
      await screen.findByText(ASKING, {}, WAIT);
      const told = /this page asks the seller again each time it opens\./;
      await until(() => {
        clock.offset += 61_000;
        return screen.queryByText(told) !== null;
      }, 20_000);
      expect(screen.queryByText(ASKING)).toBeNull();
      expect(within(screen.getByRole('banner')).queryByRole('button', { name: /^Swap · / })).toBeNull();
      await new Promise((r) => setTimeout(r, 500));
      expect(resume.mock.calls.filter(([, id]) => `swap:${id}` === key)).toHaveLength(1);
      expect(Object.keys(JSON.parse((await w.store.get(key)).state))[0]).toBe('Punished');
    } finally {
      resume.mockRestore();
    }
  });
});
