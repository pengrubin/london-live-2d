import { describe, expect, it } from 'vitest';
import { isPeak, isServiceRunning, type ServiceSpec } from './simulated-trains';

/** Dubai's published hours: 05:00–24:00, to 01:00 Fri, from 08:00 Sun. UTC+4. */
const DUBAI: ServiceSpec = {
  utcOffsetHours: 4,
  hours: [
    { open: 8, close: 24 }, // Sun
    { open: 5, close: 24 }, // Mon
    { open: 5, close: 24 }, // Tue
    { open: 5, close: 24 }, // Wed
    { open: 5, close: 24 }, // Thu
    { open: 5, close: 25 }, // Fri — 01:00 Saturday
    { open: 5, close: 24 }, // Sat
  ],
  peakHours: [
    [7, 10],
    [17, 21],
  ],
};

/** Builds an instant from a local Dubai wall-clock time (UTC+4, no DST). */
const dubaiLocal = (iso: string): number => Date.parse(`${iso}+04:00`);

describe('isServiceRunning', () => {
  it('runs during the ordinary weekday window', () => {
    // Wednesday 2026-08-05
    expect(isServiceRunning(DUBAI, dubaiLocal('2026-08-05T09:00'))).toBe(true);
    expect(isServiceRunning(DUBAI, dubaiLocal('2026-08-05T23:30'))).toBe(true);
  });

  it('stops overnight', () => {
    expect(isServiceRunning(DUBAI, dubaiLocal('2026-08-05T02:00'))).toBe(false);
    expect(isServiceRunning(DUBAI, dubaiLocal('2026-08-05T04:59'))).toBe(false);
  });

  it('opens exactly at the published time and closes exactly at it', () => {
    expect(isServiceRunning(DUBAI, dubaiLocal('2026-08-05T05:00'))).toBe(true);
    // 24:00 Wednesday is 00:00 Thursday, when Thursday's window has not opened.
    expect(isServiceRunning(DUBAI, dubaiLocal('2026-08-06T00:00'))).toBe(false);
  });

  it('starts late on Sunday', () => {
    // 2026-08-02 is a Sunday.
    expect(isServiceRunning(DUBAI, dubaiLocal('2026-08-02T07:30'))).toBe(false);
    expect(isServiceRunning(DUBAI, dubaiLocal('2026-08-02T08:30'))).toBe(true);
  });

  // The case most likely to be wrong: a closing time past midnight belongs to
  // the PREVIOUS day's window, so it must be found by looking backwards.
  it("honours Friday's service running into Saturday morning", () => {
    // 2026-08-07 is a Friday; it closes at 01:00 on Saturday the 8th.
    expect(isServiceRunning(DUBAI, dubaiLocal('2026-08-08T00:30'))).toBe(true);
    expect(isServiceRunning(DUBAI, dubaiLocal('2026-08-08T01:30'))).toBe(false);
  });

  it('does not leak late service into other days', () => {
    // Thursday closes at 24:00, so 00:30 Friday must be shut.
    expect(isServiceRunning(DUBAI, dubaiLocal('2026-08-07T00:30'))).toBe(false);
  });

  it('applies the UTC offset rather than the viewer local time', () => {
    // 22:00 UTC is 02:00 next day in Dubai — shut, whatever the browser thinks.
    expect(isServiceRunning(DUBAI, Date.parse('2026-08-05T22:00Z'))).toBe(false);
    // 06:00 UTC is 10:00 in Dubai — running.
    expect(isServiceRunning(DUBAI, Date.parse('2026-08-05T06:00Z'))).toBe(true);
  });
});

describe('isPeak', () => {
  it('is peak inside the published windows only', () => {
    expect(isPeak(DUBAI, dubaiLocal('2026-08-05T08:00'))).toBe(true);
    expect(isPeak(DUBAI, dubaiLocal('2026-08-05T18:30'))).toBe(true);
    expect(isPeak(DUBAI, dubaiLocal('2026-08-05T12:00'))).toBe(false);
    expect(isPeak(DUBAI, dubaiLocal('2026-08-05T22:00'))).toBe(false);
  });

  it('treats each window as half-open, so the end hour is off-peak', () => {
    expect(isPeak(DUBAI, dubaiLocal('2026-08-05T07:00'))).toBe(true);
    expect(isPeak(DUBAI, dubaiLocal('2026-08-05T10:00'))).toBe(false);
  });
});
