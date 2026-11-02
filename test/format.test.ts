import { expect, test } from 'vitest';
import { btc, duration, nex, nexFor, parseBtc } from '../src/format';

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
