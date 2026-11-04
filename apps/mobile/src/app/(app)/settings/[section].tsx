import { Stack, useLocalSearchParams } from 'expo-router';
import { EmptyState, Screen } from '@/components/ui';
import General from '@/features/settings/General';
import Preferences from '@/features/settings/Preferences';
import Members from '@/features/settings/Members';
import Permissions from '@/features/settings/Permissions';
import Agents from '@/features/settings/Agents';
import Skills from '@/features/settings/Skills';
import Automations from '@/features/settings/Automations';
import Connectors from '@/features/settings/Connectors';
import Memory from '@/features/settings/Memory';
import Activity from '@/features/settings/Activity';
import Usage from '@/features/settings/Usage';
import Archive from '@/features/settings/Archive';
import { settingsSections } from '@/features/settings/SettingsScreen';

const screens = { general: General, preferences: Preferences, members: Members, permissions: Permissions, agents: Agents, skills: Skills, automations: Automations, connectors: Connectors, memory: Memory, activity: Activity, usage: Usage, archive: Archive };
export default function SettingsRoute() {
  const { section, itemId, connectorId } = useLocalSearchParams<{ section: string; itemId?: string; connectorId?: string }>();
  const Component = screens[section as keyof typeof screens];
  const title = section === 'preferences' ? 'Your preferences' : settingsSections.find(s => s.id === section)?.label ?? 'Settings';
  return <><Stack.Screen options={{ title }} />{section === 'permissions' ? <Permissions key={`permissions:${connectorId ?? ''}`} connectorId={typeof connectorId === 'string' ? connectorId : undefined} /> : Component ? <Component key={`${section}:${itemId ?? ''}`} /> : <Screen><EmptyState title="Settings page not found" /></Screen>}</>;
}
