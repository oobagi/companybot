import { describe, expect, it } from 'vitest';
import { formCron, scheduleForm, type ScheduleForm } from '@companybot/core/schedules';
import { nextScheduleTime } from './scheduleTimes';

describe('schedule time rows', () => {
  it.each([
    '30 9,13 * * *',
    '45 9,13 * * 1',
    '0 9,13 15 * *',
    '15 9,13 * * 1#2',
    '0 9,13 * * 5L',
  ])('adds, edits, removes and reopens times without changing recurrence for %s', cron => {
    const original = scheduleForm(cron)!;
    expect(original).toHaveProperty('times');
    if (!('times' in original)) throw new Error('Expected a schedule with time rows.');
    const added: ScheduleForm = { ...original, times: [...original.times, nextScheduleTime(original.times)] };
    const addedCron = formCron(added);
    expect(typeof addedCron).toBe('string');
    expect(scheduleForm(addedCron as string)).toEqual(added);
    const edited = { ...added, times: added.times.map((time, index) => index === added.times.length - 1 ? `18:${time.slice(3)}` : time) };
    expect(scheduleForm(formCron(edited) as string)).toEqual(edited);
    expect(formCron({ ...edited, times: edited.times.slice(0, -1) })).toBe(cron);
  });

  it('wraps midnight and skips existing hours without changing the selected minute', () => {
    expect(nextScheduleTime(['00:45', '01:45', '23:45'])).toBe('02:45');
    expect(nextScheduleTime([])).toBe('09:00');
  });

  it('keeps complex minute/hour combinations intact and rejects an incompatible edit', () => {
    const form = scheduleForm('0,30 9,13 * * 1-5')!;
    if (!('times' in form)) throw new Error('Expected a schedule with time rows.');
    expect(form.times).toEqual(['09:00', '09:30', '13:00', '13:30']);
    expect(formCron(form)).toBe('0,30 9,13 * * 1-5');
    expect(formCron({ ...form, times: [...form.times, nextScheduleTime(form.times)] })).toEqual({ error: expect.stringContaining('Times in one schedule share their minutes') });
    expect(formCron({ ...form, times: form.times.filter(time => time !== '13:30') })).toEqual({ error: expect.stringContaining('Times in one schedule share their minutes') });
  });

  it('preserves hours-mode and advanced expressions for the existing controls', () => {
    const hours = scheduleForm('15 9-17/2 * * 1-5')!;
    expect(hours.repeats).toBe('hours');
    expect(formCron(hours)).toBe('15 9-17/2 * * 1-5');
    expect(scheduleForm('0 9 1,15 * *')).toBeNull();
  });
});
