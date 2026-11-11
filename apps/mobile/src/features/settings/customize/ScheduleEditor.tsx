import { allDays, dayNames, describeCron, formCron, nextRuns, scheduleError, scheduleForm, type ScheduleForm } from '@companybot/core/schedules';
import { useState } from 'react';
import { Button, ChoicePicker, Field, Stack, Text } from '@/components/ui';
import { TimeInput } from '@/components/ui/native-controls/TimeInput';
import { nextScheduleTime } from './scheduleTimes';

/** Human-friendly controls compile through the exact same domain helpers as desktop. */
export function ScheduleEditor({ cron, timeZone, onChange, disabled }: { cron: string; timeZone: string; onChange: (cron: string) => void; disabled?: boolean }) {
  const [previewFrom] = useState(() => Date.now());
  const [form, setForm] = useState<ScheduleForm | null>(() => scheduleForm(cron));
  const [advanced, setAdvanced] = useState(!form);
  const [formError, setFormError] = useState<string>();
  const change = (value: ScheduleForm) => {
    setForm(value);
    if ('times' in value && value.times.some((time) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) { setFormError('Use 24-hour times such as 09:00 and 13:30.'); onChange(''); return; }
    const result = formCron(value);
    if (typeof result !== 'string') { setFormError(result.error); onChange(''); }
    else { setFormError(undefined); onChange(result); }
  };
  const problem = formError ?? scheduleError(cron);
  let upcoming: number[] = [];
  if (!problem) { try { upcoming = nextRuns(cron, timeZone, previewFrom, 3); } catch { /* Invalid zone is validated by the parent form. */ } }
  return <Stack>
    <Button label={advanced ? 'Use schedule controls' : 'Edit cron expression'} variant="ghost" disabled={disabled} onPress={() => { if (advanced) { const parsed = scheduleForm(cron) ?? { repeats: 'daily' as const, days: allDays, times: ['09:00'] }; change(parsed); } setAdvanced(!advanced); }} />
    {advanced ? <Field label="Cron expression" value={cron} editable={!disabled} onChangeText={(value) => { setFormError(undefined); onChange(value); }} autoCapitalize="none" autoCorrect={false} hint="Minute, hour, day, month, weekday. Example: 0 9 * * 1-5" /> : form && <>
      <ChoicePicker label="Repeats" disabled={disabled} value={form.repeats} options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'hours', label: 'Every few hours' }, { value: 'monthly', label: 'Monthly' }]} onChange={(value) => {
        if (value === 'daily' || value === 'weekly') change({ repeats: value, days: value === 'daily' ? allDays : [1], times: ['09:00'] });
        else if (value === 'hours') change({ repeats: 'hours', days: [1, 2, 3, 4, 5], every: 2, from: 9, to: 17, minute: 0 });
        else if (value === 'monthly') change({ repeats: 'monthly', on: 1, times: ['09:00'] });
      }} />
      {'days' in form && <ChoicePicker label="Days" value={form.days.map(String)} disabled={disabled} multiple options={dayNames.map((label, value) => ({ label, value: String(value) }))} onChange={(days) => change({ ...form, days: (Array.isArray(days) ? days : [days]).map(Number) })} />}
      {'times' in form && <Stack gap="sm">
        {form.times.map((time, index) => <Stack key={index} gap="none">
          <TimeInput label={form.times.length === 1 ? 'Time' : `Time ${index + 1}`} value={time} disabled={disabled} onChange={(value) => change({ ...form, times: form.times.map((current, at) => at === index ? value : current) })} />
          {form.times.length > 1 && <Button label="Remove time" accessibilityLabel={`Remove time ${index + 1}`} variant="ghost" disabled={disabled} style={{ alignSelf: 'flex-start' }} onPress={() => change({ ...form, times: form.times.filter((_, at) => at !== index) })} />}
        </Stack>)}
        <Button label="Add time" variant="ghost" disabled={disabled} style={{ alignSelf: 'flex-start' }} onPress={() => change({ ...form, times: [...form.times, nextScheduleTime(form.times)] })} />
      </Stack>}
      {form.repeats === 'hours' && <>
        <ChoicePicker label="Every" value={String(form.every)} disabled={disabled} options={[1, 2, 3, 4, 6, 8, 12].map((n) => ({ value: String(n), label: `${n} hour${n === 1 ? '' : 's'}` }))} onChange={(value) => { if (value) change({ ...form, every: Number(value) }); }} />
        <Field label="Starting hour (0–23)" value={String(form.from)} editable={!disabled} keyboardType="number-pad" onChangeText={(value) => change({ ...form, from: Number(value) })} />
        <Field label="Ending hour (0–23)" value={String(form.to)} editable={!disabled} keyboardType="number-pad" onChangeText={(value) => change({ ...form, to: Number(value) })} />
        <Field label="Minute past the hour (0–59)" value={String(form.minute)} editable={!disabled} keyboardType="number-pad" onChangeText={(value) => change({ ...form, minute: Number(value) })} />
      </>}
      {form.repeats === 'monthly' && <>
        <ChoicePicker label="Monthly on" disabled={disabled} value={typeof form.on === 'number' ? 'day' : 'weekday'} options={[{ value: 'day', label: 'A day of the month' }, { value: 'weekday', label: 'A weekday occurrence' }]} onChange={(value) => { if (value === 'day') change({ ...form, on: 1 }); else if (value === 'weekday') change({ ...form, on: { nth: 1, weekday: 1 } }); }} />
        {typeof form.on === 'number' ? <ChoicePicker label="Day of month" value={String(form.on)} disabled={disabled} options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} onChange={(value) => { if (value) change({ ...form, on: Number(value) }); }} /> : <>
          <ChoicePicker label="Occurrence" disabled={disabled} value={String(form.on.nth)} options={[{ value: '1', label: 'First' }, { value: '2', label: 'Second' }, { value: '3', label: 'Third' }, { value: '4', label: 'Fourth' }, { value: 'last', label: 'Last' }]} onChange={(value) => { if (value && typeof form.on !== 'number') change({ ...form, on: { ...form.on, nth: value === 'last' ? 'last' : Number(value) as 1 | 2 | 3 | 4 } }); }} />
          <ChoicePicker label="Weekday" disabled={disabled} value={String(form.on.weekday)} options={dayNames.map((label, value) => ({ label, value: String(value) }))} onChange={(value) => { if (value !== '' && typeof form.on !== 'number') change({ ...form, on: { ...form.on, weekday: Number(value) } }); }} />
        </>}
      </>}
    </>}
    {problem ? <Text tone="danger" accessibilityRole="alert">{problem}</Text> : <><Text>{describeCron(cron)} · {timeZone}</Text><Text variant="caption" tone="muted">Next: {upcoming.map((at) => new Date(at).toLocaleString(undefined, { timeZone })).join(' · ')}</Text></>}
  </Stack>;
}
