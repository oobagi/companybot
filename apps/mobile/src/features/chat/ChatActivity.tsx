import { useState } from 'react';
import { Keyboard, View } from 'react-native';
import { Button, EditorSheet, EmptyState, ErrorState, ListRow, Stack } from '@/components/ui';
import { useTheme } from '@/design';

export type ActivityPerson = { id: string; name: string };
export type ActivityAgent = { turnId: string; name: string; step: string | null; canStop: boolean; stopping: boolean };

/** A bounded summary protects the timeline/composer; details and Stop live in a native sheet. */
export function ChatActivity({ people, agents, busy = false, error, onStop }: { people: readonly ActivityPerson[]; agents: readonly ActivityAgent[]; busy?: boolean; error?: string; onStop: (turnId: string) => void }) {
  const [open, setOpen] = useState(false);
  const { spacing, sizes } = useTheme();
  const activity = [agents.length && `${agents.length} ${agents.length === 1 ? 'agent working' : 'agents working'}`, people.length && `${people.length} ${people.length === 1 ? 'person typing' : 'people typing'}`].filter(Boolean).join(' · ');
  if (!activity && !open && !error) return null;
  const label = activity ? `Activity · ${agents.length + people.length}` : 'Activity issue';
  return <View style={{ minHeight: sizes.touch, paddingHorizontal: spacing.sm }}>
    {(activity || error) && <Button label={label} accessibilityLabel={`Conversation activity: ${activity || 'No current activity'}${error ? '. An activity action failed. View details.' : ''}`} variant="ghost" onPress={() => { Keyboard.dismiss(); setOpen(true); }} />}
    {open && <EditorSheet title="Conversation activity" busy={busy} onClose={() => setOpen(false)}>
      {error && <ErrorState message={error} />}
      <Stack gap="none">
        {agents.map(agent => <ListRow key={agent.turnId} title={agent.name} description={agent.step ?? 'Writing…'} trailing={agent.canStop ? <Button label={agent.stopping ? 'Stopping…' : 'Stop'} accessibilityLabel={`Stop ${agent.name}`} variant="ghost" disabled={agent.stopping || busy} onPress={() => onStop(agent.turnId)} /> : undefined} />)}
        {people.map(person => <ListRow key={person.id} title={person.name} description="Typing…" />)}
      </Stack>
      {!activity && <EmptyState title="No activity" description="Nobody is typing or working here right now." />}
    </EditorSheet>}
  </View>;
}
