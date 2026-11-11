import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable } from 'react-native';
import { Avatar, Badge, Button, EditorSheet, ErrorState, Loading, Stack, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import type { Message } from './types';

type Participant = Message['author'];
export function ProfileLink({ who, children }: { who: Participant; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { sizes } = useTheme();
  return <><Pressable accessibilityRole="button" accessibilityLabel={`View ${who.name}'s profile`} onPress={() => setOpen(true)} style={{ minHeight: sizes.touch, justifyContent: 'center', flexShrink: 1 }}>{children}</Pressable>{open && <Profile who={who} onClose={() => setOpen(false)} />}</>;
}

export function Profile({ who, onClose }: { who: Participant; onClose: () => void }) {
  const [shown, setShown] = useState(who);
  const [now, setNow] = useState(() => Date.now());
  const team = useQuery(api.workspace.team);
  const roles = useQuery(api.roles.list);
  const chats = useQuery(api.chats.list);
  const openDm = useMutation(api.chats.openDm);
  const task = useTask();
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const person = shown.type === 'user' ? team?.members.find(p => p.userId === shown.id) : undefined;
  const agent = shown.type === 'agent' ? chats?.agents.find(a => a._id === shown.id) : undefined;
  const loaded = shown.type === 'user' ? team !== undefined : chats !== undefined;
  const gone = loaded && !person && !agent;
  const localTime = person?.timeZone ? new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: person.timeZone }) : null;
  return <EditorSheet size="content" busy={task.busy} title="Profile" onClose={onClose}><Stack horizontal><Avatar name={shown.name} image={shown.image} agent={shown.type === 'agent'} size="lg" /><Stack style={{ flex: 1 }}><Text variant="heading">{shown.name}</Text>{shown.type === 'agent' && <Badge label="Bot" />}</Stack></Stack>
    {!loaded && <Loading layout="inline" />}
    {person && <><Text selectable>{person.email}</Text><Text tone="muted">{roles?.filter(role => person.roles.includes(role.id)).map(role => role.name).join(', ') || 'Workspace member'}{person.isYou ? ' · You' : ''}</Text>{localTime && <Text tone="muted">{localTime} · {person.timeZone}</Text>}</>}
    {agent?.description && <Text>{agent.description}</Text>}
    {shown.for && <Button label={`Sent for ${shown.for.name}`} variant="ghost" onPress={() => { task.clear(); setShown(shown.for!); }} />}
    {gone && <Text tone="muted">No longer in this workspace.</Text>}
    {task.error && <ErrorState message={task.error} />}
    {loaded && !gone && !person?.isYou && <Button label="Message" loading={task.busy} onPress={() => void task.run(async () => {
      const chatId = await openDm(shown.type === 'user' ? { userIds: [shown.id], agentIds: [] } : { userIds: [], agentIds: [shown.id] });
      onClose(); router.push({ pathname: '/chat/[chatId]', params: { chatId } });
    })} />}
  </EditorSheet>;
}
