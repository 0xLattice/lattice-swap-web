// Whole flows through the page, against the driver's fakes.

import { describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { MemoryStore, Wallet, Buyer } from 'lattice-swap-driver';
import { Locks, until } from '../vendor/lattice-swap/web/driver/test/fakes.js';
import { App } from '../src/app';
import { btc } from '../src/format';
import { call, confirm, deposit, driverOf, posted, POLICY, signedOffer, world, type World } from './world';
import { listOffers } from '../src/offers';

const WAIT = { timeout: 20_000 };

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
  // A fresh browser: no key made to price the fee, only once the swap starts.
  expect(screen.getByText('Network fee').nextSibling?.textContent).toBe('unknown');
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
    await waitFor(() => expect(screen.getByText('Network fee').nextSibling?.textContent).toBe(`~${btc(need - 1_000_000)} BTC`), WAIT);
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
    expect((await listOffers(w.config.relay!, 'regtest', 'genesis')).map((l) => l.text)).toEqual([w.offer]);
    render(<App config={w.config} />);
    await screen.findByText(/best of 1/, {}, WAIT);
    expect(screen.getByText(/1 NEX = 0\.02000000 BTC/)).toBeTruthy();
    fireEvent.input(screen.getByLabelText('You pay'), { target: { value: '0.01' } });
    expect(screen.getByTestId('quote').textContent).toBe('0.5');
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
    expect(screen.getByRole('heading', { name: /0\.01000000 BTC → 0\.5 NEX/ })).toBeTruthy();
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
