import { afterEach, describe, expect, it, vi } from 'vitest';
import { localTimeToWallClock, wallClockTimeToLocal } from './wallClockTime';

const originalZone = process.env.TZ;
afterEach(() => {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
  vi.useRealTimers();
});

describe('wall-clock time picker values', () => {
  it.each(['UTC', 'America/Los_Angeles', 'Europe/Berlin', 'Asia/Kolkata', 'Pacific/Auckland', 'Australia/Lord_Howe'])('preserves every minute in %s, including midnight and noon', zone => {
    process.env.TZ = zone;
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const value = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      expect(localTimeToWallClock(wallClockTimeToLocal(value)!)).toBe(value);
    }
  });

  it('does not shift a recurring time through today’s daylight-saving gap', () => {
    process.env.TZ = 'America/Los_Angeles';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T12:00:00-07:00'));
    expect(localTimeToWallClock(wallClockTimeToLocal('02:30')!)).toBe('02:30');
    expect(wallClockTimeToLocal('02:30')?.getFullYear()).toBe(2000);
  });

  it.each(['', '9:00', '24:00', '12:60', '-1:00', '12:30:00', ' 09:00', '09:00 '])('rejects invalid HH:mm value %j', value => {
    expect(wallClockTimeToLocal(value)).toBeUndefined();
  });
});
