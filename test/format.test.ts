import { expect, test } from 'vitest';
import { bounded, btc, duration, nex, nexFor, parseBtc, refundAfter } from '../src/format';
import { reminder } from '../src/download';
import { offerFor } from '../src/offers';
import type { Listed, Offer } from '../src/types';

test('amounts', () => {
  expect(btc(0)).toBe('0.00000000');
  expect(btc(123_456_789)).toBe('1.23456789');
  expect(nex(250_000n)).toBe('0.25');
  expect(nex(3_000_000n)).toBe('3');
  expect(parseBtc('0.005')).toBe(500_000);
  expect(parseBtc('.1')).toBe(10_000_000);
  expect(parseBtc('1.000000001')).toBeNull();
  expect(parseBtc('')).toBeNull();
  expect(parseBtc('abc')).toBeNull();
  // Rounded down, as the driver buys: the last satoshi buys nothing.
  expect(nexFor(500_001, 2_000_000)).toBe(250_000n);
});

test('durations', () => {
  expect(duration(45 * 60_000)).toBe('~45 min');
  expect(duration(5 * 3_600_000)).toBe('~5 hours');
  expect(duration(294 * 600_000)).toBe('~2 days');
});

test('the refund time counts the lock, t1, cancel’s depth and the refund’s', () => {
  const offer = (t1: number, btc_confirmations: number) => ({ template: { t1, btc_confirmations } }) as Offer;
  // 1 + 6 + 2 * 2 = 11 blocks.
  expect(refundAfter(offer(6, 2))).toBe('~110 min');
  // 1 + 288 + 2 * 6 = 301 blocks, ~50 hours.
  expect(refundAfter(offer(288, 6))).toBe('~2 days');
});

test('text from a server is cut to a length the page can show', () => {
  expect(bounded('short')).toBe('short');
  expect(bounded('x'.repeat(240))).toBe('x'.repeat(240));
  expect(bounded('x'.repeat(241))).toBe(`${'x'.repeat(239)}…`);
});

test('the offer taken: the pick while listed, else none and gone; the best with no pick', () => {
  const listed = (text: string) => ({ text, offer: {} as Offer }) as Listed;
  const [best, other] = [listed('best'), listed('other')];
  expect(offerFor([best, other], null)).toEqual({ offer: best, gone: false });
  expect(offerFor([best, other], 'other')).toEqual({ offer: other, gone: false });
  // Never the best in its place.
  expect(offerFor([best], 'other')).toEqual({ offer: null, gone: true });
  expect(offerFor([], null)).toEqual({ offer: null, gone: false });
});

test('the calendar file is RFC 5545 text: escaped, and folded at 75 octets', () => {
  const ics = reminder('ab'.repeat(32), Date.UTC(2026, 0, 2, 3, 4, 5), 'Open; the page, now', `a\\b, c; d\n${'é'.repeat(60)}`);
  expect(ics.endsWith('\r\n')).toBe(true);
  const lines = ics.slice(0, -2).split('\r\n');
  const encoder = new TextEncoder();
  for (const line of lines) expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
  // Unfolded, each property is whole again.
  const unfolded = ics.replace(/\r\n /g, '');
  expect(unfolded).toContain(`\r\nUID:${'ab'.repeat(32)}@lattice-swap\r\n`);
  expect(unfolded).toContain('\r\nDTSTART:20260102T030405Z\r\n');
  expect(unfolded).toContain('\r\nSUMMARY:Open\\; the page\\, now\r\n');
  expect(unfolded).toContain(`\r\nDESCRIPTION:a\\\\b\\, c\\; d\\n${'é'.repeat(60)}\r\n`);
  expect(lines.some((line) => line.startsWith(' '))).toBe(true);
});
