// Whole flows through the page, against the driver's fakes.

import { describe, expect, test } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { MemoryStore, Wallet, Buyer } from 'lattice-swap-driver';
import { Locks, until } from '../vendor/lattice-swap/web/driver/test/fakes.js';
import { App } from '../src/app';
import { call, confirm, deposit, driverOf, posted, POLICY, world, type World } from './world';

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
  await waitFor(() => expect(screen.getByText(/^~0\.0000\d+ BTC$/)).toBeTruthy(), WAIT);
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
    tab(/^Swap · running$/);
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
