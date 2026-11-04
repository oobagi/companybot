import { afterEach, describe, expect, it, vi } from 'vitest';
import { calendarDateToLocal, localDateToCalendar } from './calendarDate';
import { createConfirmationController } from './confirmation';

afterEach(() => vi.unstubAllEnvs());

describe('native calendar record dates', () => {
  it.each(['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC'])('keeps stored days unchanged in %s, including DST transitions', zone => {
    vi.stubEnv('TZ', zone);
    for (const day of ['2026-03-08', '2026-11-01', '2028-02-29', '2000-01-01']) {
      const date = calendarDateToLocal(day)!;
      expect(localDateToCalendar(date)).toBe(day);
      expect(date.getHours()).toBe(12);
    }
  });
  it('uses the selected local calendar day rather than the UTC day', () => {
    vi.stubEnv('TZ', 'Pacific/Kiritimati');
    const picked = new Date('2026-11-04T12:00:00+14:00');
    expect(picked.toISOString().slice(0, 10)).toBe('2026-11-03');
    expect(localDateToCalendar(picked)).toBe('2026-11-04');
  });
  it('rejects malformed and impossible days instead of silently rolling to another month', () => {
    for (const day of ['2026-02-29', '2026-13-01', '2026-04-31', '2026-1-1', '']) expect(calendarDateToLocal(day)).toBeNull();
  });
});

describe('native confirmation lifecycle', () => {
  it('declines a second request while the first native alert remains open', async () => {
    const present = vi.fn();
    const controller = createConfirmationController(present);
    const first = controller.confirm({ title: 'Delete A?', body: 'Cannot be undone', danger: true });
    expect(await controller.confirm({ title: 'Delete B?', body: 'Cannot be undone' })).toBe(false);
    expect(present).toHaveBeenCalledOnce();
    present.mock.calls[0][1](true);
    expect(await first).toBe(true);
  });
  it('cancels on unmount and ignores stale native button and dismiss callbacks', async () => {
    const present = vi.fn();
    const controller = createConfirmationController(present);
    const first = controller.confirm({ title: 'Delete A?', body: 'Cannot be undone' });
    const stale = present.mock.calls[0][1];
    controller.cancel();
    expect(await first).toBe(false);
    const second = controller.confirm({ title: 'Delete B?', body: 'Cannot be undone' });
    stale(true); stale(false);
    expect(await controller.confirm({ title: 'Third?', body: '' })).toBe(false);
    present.mock.calls[1][1](false);
    expect(await second).toBe(false);
  });
  it('settles cancel when the platform cannot present a dialog', async () => {
    const controller = createConfirmationController(() => { throw new Error('No presenter'); });
    expect(await controller.confirm({ title: 'Delete?', body: '' })).toBe(false);
  });
});
