import { router } from 'expo-router';
import { Modal } from 'react-native';
import { DirectoryHeader } from '@/features/session/DirectoryHeader';
import { SettingsContent } from './SettingsContent';
import { useAuthActions } from '@convex-dev/auth/react';
import { useNotifications } from '@/lib/notifications/NotificationsProvider';
import { useWorkspaceTransition } from '@/features/session/useWorkspaceTransition';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';
import { Loading, Screen } from '@/components/ui';

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
  const me = useQuery(api.workspace.me);
  const prefs = useQuery(api.preferences.get);
  const { signOut } = useAuthActions();
  const { beforeSignOut } = useNotifications();
  // Approve existing drafts before locking navigation for the asynchronous cleanup.
  const task = useWorkspaceTransition();
  const groups = [
    { title: 'Workspace', ids: ['general', 'usage', 'activity', 'archive'] },
    { title: 'People', ids: ['members'] },
    { title: 'Agents', ids: ['agents', 'skills', 'memory', 'permissions'] },
    { title: 'Connections', ids: ['connectors', 'automations'] },
  ].map(group => ({ title: group.title, rows: group.ids.map(id => settingsSections.find(section => section.id === id)!).map(section => ({ ...section, onPress: () => router.push({ pathname: '/settings/[section]', params: { section: section.id } }) })) }));
  const openAccount = () => router.push('/settings/preferences');
  const logOut = () => void task.run(async isCurrent => { await beforeSignOut(); if (isCurrent()) await signOut(); });
  const name = prefs?.displayName || me?.email || 'Your account';
  return <><DirectoryHeader /><Screen nativeScroll padded={false} edges={['left', 'right']}>
    <SettingsContent name={name} email={me?.email} image={prefs?.image} onAccount={openAccount} groups={groups} onSignOut={logOut} signingOut={task.busy} error={task.error} />
  </Screen><Modal visible={task.busy} presentationStyle="fullScreen" onRequestClose={() => {}}>
    <Screen edges={['top', 'left', 'right', 'bottom']}><Loading label="Signing out…" /></Screen>
  </Modal></>;
}
