import { expect, test } from 'vitest';
import { costs, percent, sat } from '../src/costs';
import type { Offer } from '../src/types';

const offer = (price: number, btc_fee: number, nex_fee: number): Offer => ({
  quote: { price, min_btc_amount: 1, max_btc_amount: 100_000_000 },
  template: { swap_id: 's', btc_fee, nex_fee, t1: 20, t2: 20, btc_confirmations: 1, nex_confirmations: 1, margin: 3, nexus_genesis: 'g' },
  btc_network: 'regtest',
  relay: null,
  seller: 's',
});

test('a tiny swap: the fees are most of the rate', () => {
  // 8,000 sat at 1,000 sat a NEX locks 8 NEX; the claim keeps 0.001.
  const c = costs(offer(1_000, 1_800, 1_000), 8_000, 1_100);
  expect(c.pay).toBe(9_100);
  expect(c.receive).toBe(7_999_000n);
  expect(sat(c.claimFeeSats)).toBe('1 sat');
  expect(sat(c.effective!)).toBe('1,138 sat');
  expect(percent(c.feeShare)).toBe('12%');
  // A failed swap: cancel and refund each pay 1,800 sat from the lock.
  expect(c.refundFees).toBe(3_600);
  expect(c.refunded).toBe(4_400);
});

test('a large swap: the fees are a sliver', () => {
  const c = costs(offer(2_000_000, 1_000, 100), 1_000_000, 1_500);
  expect(c.receive).toBe(499_900n);
  expect(sat(c.effective!)).toBe('2,003,401 sat');
  expect(percent(c.feeShare)).toBe('0.2%');
  expect(c.refunded).toBe(998_000);
});

test('the lock fee unknown: only the swap’s own fees count', () => {
  const c = costs(offer(1_000, 1_800, 1_000), 8_000, null);
  expect(c.pay).toBe(8_000);
  expect(c.feeShare).toBeCloseTo(1 - 7_999 / 8_000);
});

test('no NEX left after the claim fee: no rate, all fees', () => {
  const c = costs(offer(1_000, 1_800, 1_000), 1, 1_100);
  expect(c.receive).toBe(0n);
  expect(c.effective).toBeNull();
  expect(c.feeShare).toBe(1);
});
