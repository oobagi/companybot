import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import type { FunctionReturnType } from 'convex/server';
import { router } from 'expo-router';
import { Button, Card, ErrorState, Section, Stack, Text, useConfirm } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';

type Wakeup = FunctionReturnType<typeof api.wakeups.list>[number];
function repeats(wakeup: Wakeup) {
  if (!wakeup.every) return '';
  const day = 86_400_000;
  const [count, unit] = wakeup.every % (7 * day) === 0 ? [wakeup.every / (7 * day), 'week'] : wakeup.every % day === 0 ? [wakeup.every / day, 'day'] : [Math.round(wakeup.every / 3_600_000), 'hour'];
  return `Every ${count} ${unit}${count === 1 ? '' : 's'}${wakeup.left === null ? '' : ` · ${wakeup.left} times left`}`;
}
export function PendingWakeups({ recordId }: { recordId?: Id<'records'> }) {
  const wakeups = useQuery(api.wakeups.list, { recordId });
  const cancel = useMutation(api.wakeups.cancel);
  const task = useTask(); const { confirm, dialog } = useConfirm();
  if (!wakeups?.length) return null;
  return <Section title="Follow-ups" description="Times an agent will check back in the chat where it was asked.">{dialog}{task.error && <ErrorState message={task.error} />}
    {wakeups.map((wakeup) => <Card key={wakeup._id}><Text>{wakeup.note ?? (wakeup.place ? wakeup.job ? 'When its job finishes' : 'Look for anything worth doing' : 'In a chat you cannot see')}</Text>
      <Text tone="muted">{wakeup.held ? 'Waiting for something in Archive' : wakeup.at ? `Next: ${new Date(wakeup.at).toLocaleString()}` : 'When its job finishes'}{repeats(wakeup) ? ` · ${repeats(wakeup)}` : ''}</Text>
      <Text variant="caption" tone="muted">{wakeup.agent} · for {wakeup.mine ? 'you' : wakeup.actor}</Text>
      <Stack horizontal style={{ flexWrap: 'wrap' }}>{wakeup.place && <Button label={wakeup.place.label} variant="ghost" onPress={() => {
        const place = wakeup.place!;
        router.push(place.threadId ? { pathname: '/chat/[chatId]/thread/[threadId]', params: { chatId: place.chatId, threadId: place.threadId } } : { pathname: '/chat/[chatId]', params: { chatId: place.chatId } });
      }} />}{wakeup.record && !recordId && <Button label={wakeup.record.title} variant="ghost" onPress={() => router.push({ pathname: '/record/[recordId]', params: { recordId: wakeup.record!._id } })} />}</Stack>
      {wakeup.canCancel && <Button label="Cancel follow-up" variant="danger" disabled={task.busy} onPress={() => void task.run(async () => { if (!await confirm({ title: 'Cancel this follow-up?', body: 'Nothing runs for it after this. An agent can set a new one if needed.', action: 'Cancel follow-up', danger: true })) return; await cancel({ id: wakeup._id }); })} />}
    </Card>)}
  </Section>;
}
