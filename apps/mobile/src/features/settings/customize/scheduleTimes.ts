import { wallClockTimeToLocal, localTimeToWallClock } from '@/components/ui/native-controls/wallClockTime';

/** Prefer another hour at the same minute so a single cron can represent it. */
export function nextScheduleTime(times: string[]): string {
  const last = wallClockTimeToLocal(times.at(-1) ?? '') ?? wallClockTimeToLocal('08:00')!;
  for (let hour = 1; hour <= 24; hour += 1) {
    const candidate = new Date(last);
    candidate.setHours((last.getHours() + hour) % 24);
    const value = localTimeToWallClock(candidate);
    if (!times.includes(value)) return value;
  }
  // All hours already exist. Keep the additional row editable; the shared cron
  // compiler explains incompatible combinations instead of silently adding runs.
  for (let minute = 1; minute < 60; minute += 1) {
    const candidate = new Date(last);
    candidate.setHours(last.getHours(), (last.getMinutes() + minute) % 60);
    const value = localTimeToWallClock(candidate);
    if (!times.includes(value)) return value;
  }
  return localTimeToWallClock(last);
}
