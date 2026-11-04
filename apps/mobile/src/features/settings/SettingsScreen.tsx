import { router } from 'expo-router';
import { Platform } from 'react-native';
import { DirectoryHeader } from '@/components/navigation/DirectoryHeader';
import { NativeSettings } from './NativeSettings';
import { useAuthActions } from '@convex-dev/auth/react';
import { useNotifications } from '@/lib/notifications/NotificationsProvider';
import { useUnsavedWork } from '@/lib/UnsavedWork';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { Avatar, Button, Card, ErrorState, ListRow, Screen, Section, Stack } from '@/components/ui';

export const settingsSections = [
  { id: 'general', label: 'General', description: 'Workspace name, currency and agent defaults' },
  { id: 'members', label: 'Members', description: 'Your team and invitations' },
  { id: 'permissions', label: 'Permissions', description: 'What agents may do for you' },
  { id: 'agents', label: 'Agents', description: 'Instructions, models and tools' },
  { id: 'skills', label: 'Skills', description: 'Reusable instructions for agents' },
  { id: 'automations', label: 'Automations', description: 'Scheduled and event-driven work' },
  { id: 'connectors', label: 'Connectors', description: 'Connect your tools and accounts' },
  { id: 'memory', label: 'Memory', description: 'What agents remember' },
  { id: 'activity', label: 'Activity', description: 'Changes and agent actions' },
  { id: 'usage', label: 'Usage', description: 'AI costs by month' },
  { id: 'archive', label: 'Archive', description: 'Restore archived items' },
];

export default function SettingsScreen() {
  const { confirmDiscard } = useUnsavedWork();
  const me = useQuery(api.workspace.me);
  const prefs = useQuery(api.preferences.get);
  const { signOut } = useAuthActions();
  const { beforeSignOut } = useNotifications();
  const task = useTask();
  const groups = [
    { title: me?.workspace ?? 'Workspace', ids: ['general', 'members', 'permissions'] },
    { title: 'Agents & tools', ids: ['agents', 'skills', 'automations', 'connectors', 'memory'] },
    { title: 'Activity', ids: ['activity', 'usage', 'archive'] },
  ].map(group => ({ title: group.title, rows: settingsSections.filter(section => group.ids.includes(section.id)).map(section => ({ ...section, onPress: () => router.push({ pathname: '/settings/[section]', params: { section: section.id } }) })) }));
  const openAccount = () => router.push('/settings/preferences');
  const logOut = () => void task.run(async () => { if (await confirmDiscard()) { await beforeSignOut(); await signOut(); } });
  const name = prefs?.displayName || me?.email || 'Your account';
  if (Platform.OS !== 'web') return <><DirectoryHeader /><Screen nativeScroll padded={false} edges={['left', 'right']}>
    <NativeSettings name={name} email={me?.email} image={prefs?.image} onAccount={openAccount} groups={groups} onSignOut={logOut} signingOut={task.busy} error={task.error} />
  </Screen></>;
  return <Screen scroll edges={['left', 'right']}><Stack gap="xl">
    <DirectoryHeader />
    <Section title="Account"><Card><ListRow title={name} description={me?.email} leading={<Avatar name={name} image={prefs?.image} />} onPress={openAccount} /></Card></Section>
    {groups.map(group => <Section key={group.rows[0]?.id ?? group.title} title={group.title}><Card>{group.rows.map(row => <ListRow key={row.id} title={row.label} description={row.description} onPress={row.onPress} />)}</Card></Section>)}
    {task.error && <ErrorState message={task.error} />}<Button label="Sign out" variant="secondary" loading={task.busy} onPress={logOut} />
  </Stack></Screen>;
}
