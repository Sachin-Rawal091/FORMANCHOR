import { describe, it, expect } from 'vitest';
import { DateParser } from '../src/content/datepickers/DateParser';

describe('DateParser Unit Tests', () => {
  it('parses valid ISO 8601 strings cleanly', () => {
    const res = DateParser.parse('2026-07-14');
    expect(res.valid).toBe(true);
    expect(res.iso).toBe('2026-07-14');
    expect(res.year).toBe(2026);
    expect(res.month).toBe(7);
    expect(res.day).toBe(14);
  });

  it('defaults ambiguous dates (both day & month <= 12) to DD/MM/YYYY', () => {
    const res = DateParser.parse('03/04/2026');
    expect(res.valid).toBe(true);
    expect(res.day).toBe(3);
    expect(res.month).toBe(4);
    expect(res.year).toBe(2026);
    expect(res.iso).toBe('2026-04-03'); // Day 3, Month April
  });

  it('parses unambiguous year-last dates correctly', () => {
    const res = DateParser.parse('25/01/2026');
    expect(res.valid).toBe(true);
    expect(res.day).toBe(25);
    expect(res.month).toBe(1);
    expect(res.year).toBe(2026);
    expect(res.iso).toBe('2026-01-25');
  });

  it('correctly handles leap years (29/02/2024 vs 29/02/2025)', () => {
    const leapRes = DateParser.parse('29/02/2024');
    expect(leapRes.valid).toBe(true);
    expect(leapRes.iso).toBe('2024-02-29');

    const nonLeapRes = DateParser.parse('29/02/2025');
    expect(nonLeapRes.valid).toBe(false);
    expect(nonLeapRes.error).toContain('Invalid day 29 for month 2');
  });

  it('prevents calendar overflow (e.g. rejecting 31/02/2026 instead of rolling over to March)', () => {
    const res = DateParser.parse('31/02/2026');
    expect(res.valid).toBe(false);
    expect(res.error).toContain('Invalid day 31 for month 2');
  });

  it('parses Lotus 1-2-3 Excel serial numbers correctly', () => {
    // 45127 is 2023-07-20 in Lotus 1-2-3 / Excel epoch (1899-12-30)
    const res = DateParser.parse(45127);
    expect(res.valid).toBe(true);
    expect(res.iso).toBe('2023-07-20');
    expect(res.isExcelSerial).toBe(true);
  });

  it('parses localized text date strings', () => {
    const res1 = DateParser.parse('14 Jul 2026');
    expect(res1.valid).toBe(true);
    expect(res1.iso).toBe('2026-07-14');

    const res2 = DateParser.parse('July 14, 2026');
    expect(res2.valid).toBe(true);
    expect(res2.iso).toBe('2026-07-14');
  });

  it('handles empty, null, or invalid date values gracefully', () => {
    expect(DateParser.parse('').valid).toBe(false);
    expect(DateParser.parse(null as any).valid).toBe(false);
    expect(DateParser.parse('invalid-text').valid).toBe(false);
  });
});
