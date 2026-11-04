/** Local calendar days match the message times shown in the timeline. */
export function sameMessageDay(left: number, right: number) {
  const a = new Date(left); const b = new Date(right);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function messageDayLabel(time: number, now = Date.now()) {
  if (sameMessageDay(time, now)) return 'Today';
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (sameMessageDay(time, yesterday.getTime())) return 'Yesterday';
  return new Date(time).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

type DatedMessage = { _id: string; _creationTime: number; status: string; privacy?: { hidden?: boolean } | null };

/** Invisible streaming rows stay mounted: their live subscriptions can reveal approval cards. */
export function messageTimeline<T extends DatedMessage>(messages: readonly T[], liveVisible: ReadonlySet<string>, now = Date.now()) {
  const days = new Map<string, string>();
  let previous: number | undefined;
  for (const message of messages) {
    if (message.status === 'streaming' && !message.privacy?.hidden && !liveVisible.has(message._id)) continue;
    if (previous === undefined || !sameMessageDay(previous, message._creationTime)) days.set(message._id, messageDayLabel(message._creationTime, now));
    previous = message._creationTime;
  }
  return { data: messages.slice().reverse(), days };
}
