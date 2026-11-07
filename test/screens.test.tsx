// Each screen's states, as `status()` gives them.

import { describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { unfinished } from '../src/app';
import { Fund } from '../src/screens/fund';
import { Progress, stepOf } from '../src/screens/progress';
import { download } from '../src/download';
import { WalletScreen } from '../src/screens/wallet';
import { Offers } from '../src/screens/offers';
import { SwapForm } from '../src/screens/swap';
import { CHECK_TIMEOUT, Settings } from '../src/screens/settings';
import { wasm } from 'lattice-swap-driver/wasm.js';
import type { AppConfig } from '../src/config';
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
    running: true,
    btc_amount: 1_000_000,
    price: 2_000_000,
    nex_amount: 500_000,
    btc_confirmations: 3,
    nex_confirmations: 2,
    nexAddress: 'bafynexaddress',
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
      backedUp={backedUp}
      save={download}
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
    expect(stepOf(status({ step: 'received' }))).toBe(3);
    expect(stepOf(status({ step: 'done', outcome: 'swapped' }))).toBe(3);
    for (const s of [status({ step: 'asking' }), status({ step: 'refunding' }), status({ step: 'refunded', outcome: 'refunded' }), status({ step: 'done', outcome: 'aborted' })]) {
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

  test('the seller’s step shows the NEX lock once seen, of its Nexus confirmations', () => {
    // The BTC lock is past its target: what is waited on is the NEX lock.
    progress(status({ confirmations: { funding: 167, lockSpend: null, cancelSpend: null, nexLock: 1 } }));
    expect(current()).toMatch(/^2Seller locks NEXNEX lock: 1 of 2 Nexus confirmations\.$/);
  });

  test('before the NEX lock, the BTC lock’s confirmations stop at their target', () => {
    progress(status({ confirmations: { funding: 167, lockSpend: null, cancelSpend: null, nexLock: null } }));
    expect(current()).toMatch(/Your lock has 3 of 3 confirmations\. Waiting for the seller to lock NEX on Nexus\. Nothing to do\.$/);
  });

  test('a NEX lock past its target shows its target', () => {
    progress(status({ confirmations: { funding: 3, lockSpend: null, cancelSpend: null, nexLock: 5 } }));
    expect(current()).toMatch(/NEX lock: 2 of 2 Nexus confirmations\.$/);
  });

  test('a warning shows in the stalled box, and the seller’s step still says what is waited on', () => {
    // A warning is any failed round, a backend's as much as the session's:
    // the step does not guess which.
    progress(
      status({ confirmations: { funding: 3, lockSpend: null, cancelSpend: null, nexLock: null }, warning: 'esplora: 503' }),
    );
    expect(screen.getByRole('alert').textContent).toMatch(/The swap is stalled.*esplora: 503/);
    expect(current()).toMatch(/Waiting for the seller to lock NEX on Nexus\. Nothing to do\.$/);
  });

  test('the lock’s depth is shown of the depth the swap asks for', () => {
    progress(status({ confirmations: { funding: 1, lockSpend: null, cancelSpend: null, nexLock: null } }));
    expect(current()).toMatch(/Your lock has 1 of 3 confirmations\./);
  });

  test('the amounts and the NEX address are status()’s', () => {
    // A NEX amount other than the price gives: the terms say what arrives.
    progress(status({ step: 'done', outcome: 'swapped', btc_amount: 30_000, nex_amount: 12_345_678 }));
    expect(screen.getByRole('heading').textContent).toBe('0.00030000 BTC → 12.345678 NEX');
    expect(screen.getByText('bafynexaddress')).toBeTruthy();
    expect(current()).toMatch(/12\.345678 NEX is in your address · /);
  });

  test('the recovery file is asked for once it covers the lock, until downloaded', () => {
    const onBackup = vi.fn();
    render(
      <Progress status={status({ backupCovers: 'lock' })} backedUp={false} save={vi.fn()} onBackup={onBackup} onWithdraw={vi.fn()} onSwapAgain={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download recovery file' }));
    expect(onBackup).toHaveBeenCalled();
    // The swap's steps are still there: the prompt blocks nothing.
    expect(current()).toMatch(/Lock your BTC/);
    expect(screen.getByRole('heading').textContent).toBe('0.01000000 BTC → 0.5 NEX');
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
    // Nothing says the page may close and be opened again later.
    expect(screen.queryByText(/come back by/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save reminder (.ics)' })).toBeNull();
  });

  test('asking says it asks the seller, without the four steps', () => {
    progress(status({ step: 'asking', mustStayOpen: true, warning: 'seller: not met', deadlines: DEADLINES }));
    expect(screen.getAllByRole('status').map((s) => s.textContent)).toEqual([
      'Keep this page openAsking the seller to release your NEX. Leave this page open until it settles.',
      'Asking the seller to release your NEX…Your refund window passed and the seller claimed your BTC. If the seller locked NEX, it is still locked, and only you and the seller together can release it.seller: not met',
    ]);
    expect(document.querySelector('.steps')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/come back by/i)).toBeNull();
  });

  test('stalled while the page must stay open: no "come back by"', () => {
    progress(status({ warning: 'broadcast: 503 down', mustStayOpen: true, deadlines: DEADLINES }));
    expect(screen.getByRole('alert').textContent).toMatch(/^The swap is stalledbroadcast: 503 downCancel fromblock 120/);
    expect(screen.queryByText(/come back by/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save reminder (.ics)' })).toBeNull();
  });

  test('a long warning is cut to a length the page can show', () => {
    progress(status({ warning: `esplora: ${'x'.repeat(5000)}`, deadlines: DEADLINES }));
    const text = screen.getByText(/^esplora: x+…$/).textContent!;
    expect(text.length).toBe(240);
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
      <Progress status={status({ step: 'refunded', outcome: 'refunded' })} backedUp={false} save={vi.fn()} onBackup={vi.fn()} onWithdraw={onWithdraw} onSwapAgain={vi.fn()} />,
    );
    expect(screen.getByText('Refunded. Your BTC is back in your wallet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(onWithdraw).toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('received: the NEX is in the address once the claim is in a block, counted past the depth asked for', () => {
    const received = (nexLock: number) => status({ step: 'received', backupCovers: 'lock', confirmations: { funding: 6, lockSpend: 6, cancelSpend: null, nexLock } });
    progress(received(1));
    expect(current()).toBe('✓NEX received0.5 NEX is in your address · 1 Nexus confirmation.');
    expect(screen.getByText('If this browser’s data is lost, this file finishes your swap.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Swap again' })).toBeNull();
    cleanup();
    progress(received(5));
    expect(current()).toBe('✓NEX received0.5 NEX is in your address · 5 Nexus confirmations.');
  });

  test('done: the NEX received', () => {
    progress(status({ step: 'done', outcome: 'swapped', backupCovers: 'lock' }));
    expect(current()).toBe('✓NEX received0.5 NEX is in your address · 2+ Nexus confirmations.Swap again');
    expect(screen.queryByText(/recovery file/)).toBeNull();
  });

  test.each([
    ['aborted', 'Stopped before anything was at stake. Your BTC is in your wallet.'],
    [
      'punished',
      'The seller has your BTC and has not released your NEX: your refund did not confirm before the punish height, so the seller claimed the BTC lock.',
    ],
    ['drained', 'The seller took your BTC and no NEX arrived: the NEX lock was already spent when your browser learned its key.'],
  ] as const)('done, %s', (outcome, text) => {
    progress(status({ step: 'done', outcome }));
    expect(screen.getByText(text)).toBeTruthy();
    expect(current()).toBeNull();
  });
});

describe('fund', () => {
  test('the address, and what is needed, confirmed and unconfirmed', () => {
    render(<Fund status={status({ step: 'fund-wallet', need: 1_000_160, wallet: { address: 'bcrt1qexample', confirmed: 5_000, unconfirmed: 20_000 } })} onPickAnother={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getAllByText('bcrt1qexample').length).toBe(1);
    expect(screen.getByRole('img', { name: 'QR code of bcrt1qexample' }).innerHTML).toMatch(/^<svg/);
    expect(screen.getByText('Needed').nextSibling?.textContent).toBe('0.01000160 BTC');
    expect(screen.getByText('Confirmed').nextSibling?.textContent).toBe('0.00005000 BTC');
    expect(screen.getByText('Unconfirmed').nextSibling?.textContent).toBe('0.00020000 BTC');
  });

  test('the offer gone, the buyer sent to pick another', () => {
    const onPickAnother = vi.fn();
    render(<Fund status={status({ step: 'offer-gone', warning: 'the offer is gone: the session ended' })} onPickAnother={onPickAnother} onCancel={vi.fn()} />);
    expect(screen.getByRole('heading').textContent).toBe('Offer gone');
    expect(screen.getByText('That offer is gone. Your funds are still in your wallet; pick another.')).toBeTruthy();
    expect(screen.queryByText('Needed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pick another offer' }));
    expect(onPickAnother).toHaveBeenCalled();
  });
});

describe('cancel', () => {
  test('the fund screen cancels the swap', () => {
    const onCancel = vi.fn(() => Promise.resolve());
    render(<Fund status={status({ step: 'fund-wallet', need: 1_000_160 })} onPickAnother={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel swap' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('a cancelled swap says nothing was sent', () => {
    render(<Fund status={status({ step: 'cancelled' })} onPickAnother={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('heading').textContent).toBe('Swap cancelled');
    expect(screen.queryByRole('button', { name: 'Cancel swap' })).toBeNull();
  });

  test('a cancelled swap, like one ended or whose offer is gone, is not carried on', () => {
    expect(unfinished(status({ step: 'fund-wallet' }))).toBe(true);
    expect(unfinished(status())).toBe(true);
    expect(unfinished(status({ step: 'cancelled' }))).toBe(false);
    expect(unfinished(status({ step: 'offer-gone' }))).toBe(false);
    expect(unfinished(status({ step: 'done', outcome: 'swapped' }))).toBe(false);
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
    expect(cells.slice(0, 3)).toEqual(['0.02000000 BTC', '0.00010000 – 0.01000000 BTC', 'BTC back in ~2 days with this page open']);
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

describe('swap', () => {
  const listed = {
    text: 'offer',
    offer: {
      quote: { price: 2_000_000, min_btc_amount: 10_000, max_btc_amount: 1_000_000 },
      template: { swap_id: 's', btc_fee: 1000, nex_fee: 100, t1: 20, t2: 20, btc_confirmations: 1, nex_confirmations: 1, margin: 3, nexus_genesis: 'g' },
      btc_network: 'regtest',
      relay: 'https://relay.example',
      seller: 's',
    },
  };
  const form = (amount: string, over: { offer?: typeof listed | null; pickGone?: boolean } = {}) =>
    render(
      <SwapForm
        relay="https://relay.example"
        offers={{ list: [listed], error: null, loaded: true }}
        offer={over.offer === undefined ? listed : over.offer}
        pickGone={over.pickGone ?? false}
        onRepick={vi.fn()}
        amount={amount}
        setAmount={vi.fn()}
        nexAddress=""
        setNexAddress={vi.fn()}
        balance={null}
        onWallet={vi.fn()}
        onReview={vi.fn()}
      />,
    );

  test.each([
    ['0.00009999', false],
    ['0.0001', true],
    ['0.01', true],
    ['0.01000001', false],
  ])('%s BTC is in the offer’s range: %s', (amount, inRange) => {
    form(amount);
    expect(screen.queryByText('Pay between 0.00010000 and 0.01000000 BTC') === null).toBe(inRange);
    expect(screen.getByTestId('quote').textContent === '0').toBe(!inRange);
  });

  test('a pick no longer listed says so and asks for another', () => {
    form('0.01', { offer: null, pickGone: true });
    expect(screen.getByRole('alert').textContent).toMatch(/^The offer you picked is gone/);
    expect(screen.queryByText('No offers on the relay right now.')).toBeNull();
    expect((screen.getByRole('button', { name: 'Swap' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Pick another offer' })).toBeTruthy();
  });
});

describe('settings', () => {
  const config: AppConfig = {
    network: 'regtest',
    esplora: 'https://esplora.example',
    nexus: 'https://nexus.example',
    defaults: { esplora: 'https://esplora.example', nexus: 'https://public-nexus.example' },
    relay: null,
    // No server answers: each check finds it unreachable.
    driver: { fetch: () => Promise.reject(new Error('offline')) },
  };
  const settings = (over: Partial<AppConfig> = {}) =>
    render(<Settings config={{ ...config, ...over }} onRestore={vi.fn()} swapRuns={async () => false} />);

  test('the Nexus read URL can be set', () => {
    settings();
    expect((screen.getByLabelText('Nexus read URL') as HTMLInputElement).value).toBe('https://nexus.example');
  });

  test('a public server says whose it is and what it is trusted for; one of your own can go back to public', async () => {
    settings();
    expect(screen.getByText('Public (esplora.example)')).toBeTruthy();
    expect(screen.getByText('You trust esplora.example to show Bitcoin in time to refund: keep amounts small.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Use the public Esplora/ })).toBeNull();
    expect(screen.getByText('Your node')).toBeTruthy();
    expect(screen.queryByText(/for how deep the seller's NEX lock is/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Use the public node (public-nexus.example)' })).toBeTruthy();
    // Each server in use is checked as Settings opens.
    expect(screen.getAllByText('Checking…')).toHaveLength(2);
    await waitFor(() => expect(screen.getAllByText('Unreachable: offline')).toHaveLength(2));
  });

  test('a public Nexus node: the trust in it', () => {
    settings({ nexus: 'https://public-nexus.example' });
    expect(screen.getByText('Public (public-nexus.example)')).toBeTruthy();
    expect(screen.queryByText('Your node')).toBeNull();
    expect(screen.getByText("You trust public-nexus.example for how deep the seller's NEX lock is: keep amounts small.")).toBeTruthy();
  });

  /** A fetch no server answers until its request is given up: each
   * request's signal in `asked`. */
  const hanging = (asked: AbortSignal[]) => (_url: string, init: RequestInit) =>
    new Promise<Response>((_, reject) => {
      asked.push(init.signal!);
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    });

  test('a check no server answers times out: unreachable, and Save is offered again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      settings({ driver: { fetch: hanging([]) } });
      expect(screen.getAllByText('Checking…')).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT);
      await waitFor(() => expect(screen.getAllByText('Unreachable: timed out')).toHaveLength(2));
      fireEvent.input(screen.getByLabelText('Bitcoin backend (Esplora)'), { target: { value: 'https://own-esplora.example' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save and reload' }));
      expect(screen.getByRole('button', { name: 'Checking…' }).hasAttribute('disabled')).toBe(true);
      await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT);
      await screen.findByText('Not saved: Unreachable: timed out');
      expect(screen.getByRole('button', { name: 'Save and reload' }).hasAttribute('disabled')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('closing Settings gives up its checks and a save under way: nothing kept, no reload', async () => {
    const asked: AbortSignal[] = [];
    const answers: (() => void)[] = [];
    const reload = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal('location', { ...location, reload });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem, removeItem: setItem });
    try {
      // Each request answered, as regtest's Esplora would, only once
      // Settings has closed.
      const fetch = (_url: string, init: RequestInit) => {
        asked.push(init.signal!);
        return new Promise<Response>((resolve) => answers.push(() => resolve(new Response(wasm.bitcoinGenesis('regtest')))));
      };
      settings({ driver: { fetch } });
      fireEvent.input(screen.getByLabelText('Bitcoin backend (Esplora)'), { target: { value: 'https://own-esplora.example' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save and reload' }));
      await waitFor(() => expect(asked).toHaveLength(3));
      cleanup();
      expect(asked.every((signal) => signal.aborted)).toBe(true);
      answers.forEach((answer) => answer());
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(setItem).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a host running its own node: Nexus is "your node", with no URL to set', () => {
    settings({ ownNode: true });
    expect(screen.queryByLabelText('Nexus read URL')).toBeNull();
    expect(screen.queryByText('https://nexus.example')).toBeNull();
    expect(screen.getByText('Your node').previousSibling?.textContent).toBe('Nexus');
    expect(screen.queryByRole('button', { name: /^Use the public node/ })).toBeNull();
    expect(screen.getByLabelText('Bitcoin backend (Esplora)')).toBeTruthy();
  });
});
