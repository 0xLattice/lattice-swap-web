// Each screen's states, as `status()` gives them.

import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/preact';
import { Fund } from '../src/screens/fund';
import { Progress, stepOf } from '../src/screens/progress';
import { WalletScreen } from '../src/screens/wallet';
import { Offers } from '../src/screens/offers';
import type { Status } from '../src/types';

const HOUR = 3_600_000;

function status(over: Partial<Status> = {}): Status {
  return {
    swapId: 'ab'.repeat(32),
    step: 'swapping',
    outcome: null,
    wallet: { address: 'bcrt1qexample', confirmed: 0, unconfirmed: 0 },
    need: null,
    confirmations: { funding: null, lockSpend: null, cancelSpend: null, nexLock: null },
    deadlines: { cancel: null, refund: null, punish: null },
    mustStayOpen: false,
    backupCovers: 'wallet',
    tip: 100,
    warning: null,
    ...over,
  };
}

const DEADLINES = {
  cancel: { height: 120, eta: Date.now() + 20 * HOUR },
  refund: { from: 121, until: 140 },
  punish: { height: 140, eta: Date.now() + 40 * HOUR },
};

const progress = (s: Status, backedUp = false) =>
  render(
    <Progress
      status={s}
      amounts={{ btc: 1_000_000, price: 2_000_000 }}
      backedUp={backedUp}
      onBackup={vi.fn()}
      onWithdraw={vi.fn()}
      onSwapAgain={vi.fn()}
    />,
  );
const current = () => document.querySelector('li[aria-current="step"]')?.textContent ?? null;

describe('progress', () => {
  test('the four steps follow the confirmations and the phase', () => {
    expect(stepOf(status())).toBe(0);
    expect(stepOf(status({ confirmations: { funding: 0, lockSpend: null, cancelSpend: null, nexLock: null } }))).toBe(0);
    expect(stepOf(status({ confirmations: { funding: 1, lockSpend: null, cancelSpend: null, nexLock: null } }))).toBe(1);
    expect(stepOf(status({ confirmations: { funding: 3, lockSpend: null, cancelSpend: null, nexLock: 0 } }))).toBe(1);
    expect(stepOf(status({ step: 'finishing' }))).toBe(2);
    expect(stepOf(status({ step: 'done', outcome: 'swapped' }))).toBe(3);
    for (const s of [status({ step: 'refunding' }), status({ step: 'refunded', outcome: 'refunded' }), status({ step: 'done', outcome: 'aborted' })]) {
      expect(stepOf(s)).toBeNull();
    }
  });

  test('a healthy swap says nothing but its step', () => {
    progress(status());
    expect(current()).toMatch(/^1Lock your BTCLocking BTC from your wallet\.$/);
    expect(screen.getByRole('heading').textContent).toBe('0.01000000 BTC → 0.5 NEX');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/recovery file/)).toBeNull();
    expect(screen.queryByText(/If the swap stalls/)).toBeNull();
  });

  test('the seller’s step shows the NEX lock once seen', () => {
    progress(status({ confirmations: { funding: 2, lockSpend: null, cancelSpend: null, nexLock: 1 } }));
    expect(current()).toMatch(/Seller locks NEX.*NEX lock is seen, 1 confirmation\./);
  });

  test('the recovery file is asked for once it covers the lock, until downloaded', () => {
    const onBackup = vi.fn();
    render(
      <Progress status={status({ backupCovers: 'lock' })} amounts={null} backedUp={false} onBackup={onBackup} onWithdraw={vi.fn()} onSwapAgain={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download recovery file' }));
    expect(onBackup).toHaveBeenCalled();
    // The swap's steps are still there: the prompt blocks nothing.
    expect(current()).toMatch(/Lock your BTC/);
    expect(screen.getByRole('heading').textContent).toBe('Your swap');
  });

  test('a downloaded file is not asked for again', () => {
    progress(status({ backupCovers: 'lock' }), true);
    expect(screen.queryByText(/recovery file/)).toBeNull();
  });

  test('the deadlines show as a reminder, with a calendar file', () => {
    progress(status({ confirmations: { funding: 1, lockSpend: null, cancelSpend: null, nexLock: null }, deadlines: DEADLINES }));
    expect(screen.getByText(/^If the swap stalls, come back by/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save reminder (.ics)' }));
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  test('finishing asks the page to stay open', () => {
    progress(status({ step: 'finishing', mustStayOpen: true, deadlines: DEADLINES }));
    expect(screen.getByRole('status').textContent).toBe('Keep this page openFinishing your swap. Leave this page open until it settles.');
    expect(current()).toMatch(/^3Finish/);
  });

  test('a failure while swapping shows as stalled, with the deadlines', () => {
    progress(status({ warning: 'broadcast: 503 down', deadlines: DEADLINES }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/^The swap is stalledbroadcast: 503 downCome back by .+ and keep this page open until your refund confirms\./);
    expect(alert.textContent).toMatch(/Cancel fromblock 120 · .+Refund inblock 121, before block 140Seller can claim fromblock 140 · .+Bitcoin tipblock 100/);
    expect(screen.queryByText(/^If the swap stalls/)).toBeNull();
  });

  test('refunding keeps the page open and shows the refund window', () => {
    progress(status({ step: 'refunding', mustStayOpen: true, deadlines: DEADLINES }));
    expect(screen.getByRole('status').textContent).toBe('Keep this page openRefunding your BTC. Leave this page open until it confirms.');
    expect(screen.getByText('Refunding your BTC')).toBeTruthy();
    expect(screen.getByText('block 121, before block 140')).toBeTruthy();
    expect(current()).toBeNull();
  });

  test('refunded offers a withdrawal and another swap', () => {
    const onWithdraw = vi.fn();
    render(
      <Progress status={status({ step: 'refunded', outcome: 'refunded' })} amounts={null} backedUp={false} onBackup={vi.fn()} onWithdraw={onWithdraw} onSwapAgain={vi.fn()} />,
    );
    expect(screen.getByText('Refunded. Your BTC is back in your wallet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(onWithdraw).toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('done: the NEX received', () => {
    progress(status({ step: 'done', outcome: 'swapped', backupCovers: 'lock' }));
    expect(current()).toBe('✓NEX received0.5 NEX is in your address.Swap again');
    expect(screen.queryByText(/recovery file/)).toBeNull();
  });

  test.each([
    ['aborted', 'Stopped before anything was at stake. Your BTC is in your wallet.'],
    ['punished', 'The seller took the BTC through punish.'],
    ['drained', 'The swap ended: the NEX lock was already spent when your browser learned its key.'],
  ] as const)('done, %s', (outcome, text) => {
    progress(status({ step: 'done', outcome }));
    expect(screen.getByText(text)).toBeTruthy();
    expect(current()).toBeNull();
  });
});

describe('fund', () => {
  test('the address, and what is needed, confirmed and unconfirmed', () => {
    render(<Fund status={status({ step: 'fund-wallet', need: 1_000_160, wallet: { address: 'bcrt1qexample', confirmed: 5_000, unconfirmed: 20_000 } })} onPickAnother={vi.fn()} />);
    expect(screen.getAllByText('bcrt1qexample').length).toBe(1);
    expect(screen.getByRole('img', { name: 'QR code of bcrt1qexample' }).innerHTML).toMatch(/^<svg/);
    expect(screen.getByText('Needed').nextSibling?.textContent).toBe('0.01000160 BTC');
    expect(screen.getByText('Confirmed').nextSibling?.textContent).toBe('0.00005000 BTC');
    expect(screen.getByText('Unconfirmed').nextSibling?.textContent).toBe('0.00020000 BTC');
  });

  test('the offer gone, the buyer sent to pick another', () => {
    const onPickAnother = vi.fn();
    render(<Fund status={status({ step: 'offer-gone', warning: 'the offer is gone: the session ended' })} onPickAnother={onPickAnother} />);
    expect(screen.getByText('That offer is gone. Your funds are still in your wallet; pick another.')).toBeTruthy();
    expect(screen.queryByText('Needed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pick another offer' }));
    expect(onPickAnother).toHaveBeenCalled();
  });
});

describe('wallet', () => {
  const wallet = { address: 'bcrt1qexample', withdraw: vi.fn() };
  const screenOf = (swapRuns: boolean) =>
    render(
      <WalletScreen
        wallet={wallet as never}
        balance={{ confirmed: 150_000, unconfirmed: 0 }}
        swapRuns={swapRuns}
        onOpen={vi.fn()}
        onBackup={vi.fn()}
      />,
    );

  test('withdraw is disabled while a swap runs', () => {
    screenOf(true);
    fireEvent.input(screen.getByLabelText('Withdraw everything to'), { target: { value: 'bcrt1qto' } });
    expect((screen.getByRole('button', { name: 'Withdraw' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Withdraw is unavailable while a swap runs.')).toBeTruthy();
  });

  test('withdraw is enabled otherwise, and the healthy balance says nothing more', () => {
    screenOf(false);
    fireEvent.input(screen.getByLabelText('Withdraw everything to'), { target: { value: 'bcrt1qto' } });
    expect((screen.getByRole('button', { name: 'Withdraw' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('balance').textContent).toBe('0.00150000 BTC');
    expect(screen.queryByText(/unconfirmed/)).toBeNull();
    expect(screen.queryByText(/unavailable/)).toBeNull();
  });
});

describe('offers', () => {
  const offer = (price: number) => ({
    text: String(price),
    offer: {
      quote: { price, min_btc_amount: 10_000, max_btc_amount: 1_000_000 },
      template: { swap_id: String(price), btc_fee: 1000, nex_fee: 100, t1: 288, t2: 144, btc_confirmations: 6, nex_confirmations: 24, margin: 6, nexus_genesis: 'g' },
      btc_network: 'bitcoin',
      relay: 'https://relay.example',
      seller: 's',
    },
  });

  test('price per NEX, range and refund time; the pick goes back to the swap', () => {
    const onPick = vi.fn();
    render(<Offers relay="https://relay.example" offers={{ list: [offer(2_000_000)], error: null, loaded: true }} onPick={onPick} />);
    const cells = [...document.querySelectorAll('tbody td')].map((td) => td.textContent);
    expect(cells.slice(0, 3)).toEqual(['0.02000000 BTC', '0.00010000 – 0.01000000 BTC', 'BTC back in ~2 days']);
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    expect(onPick).toHaveBeenCalledWith('2000000');
    expect(screen.getByRole('link', { name: 'Set up a seller →' }).getAttribute('href')).toMatch(/lattice-swap#swapping-through-a-relay$/);
  });

  test('no relay configured', () => {
    render(<Offers relay={null} offers={{ list: [], error: null, loaded: false }} onPick={vi.fn()} />);
    expect(screen.getByText('No relay configured')).toBeTruthy();
    expect(document.querySelector('table')).toBeNull();
  });
});
