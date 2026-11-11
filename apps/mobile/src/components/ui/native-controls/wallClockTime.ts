/** Native pickers need a Date, but a recurring wall-clock time is not an instant. */
export function wallClockTimeToLocal(value: string): Date | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return undefined;
  // A fixed reference day avoids today's DST gap changing e.g. 02:30 into 03:30.
  // Use local hours: Expo's Android time picker does not apply timeZoneName.
  return new Date(2000, 0, 15, Number(match[1]), Number(match[2]));
}

export function localTimeToWallClock(value: Date): string {
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}
