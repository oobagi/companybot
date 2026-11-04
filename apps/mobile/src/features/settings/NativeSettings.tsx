import General from '@expo/material-symbols/settings.xml';
import Members from '@expo/material-symbols/group.xml';
import Permissions from '@expo/material-symbols/admin_panel_settings.xml';
import Agents from '@expo/material-symbols/smart_toy.xml';
import Skills from '@expo/material-symbols/menu_book.xml';
import Automations from '@expo/material-symbols/bolt.xml';
import Connectors from '@expo/material-symbols/extension.xml';
import Memory from '@expo/material-symbols/psychology.xml';
import Activity from '@expo/material-symbols/history.xml';
import Usage from '@expo/material-symbols/bar_chart.xml';
import Archive from '@expo/material-symbols/archive.xml';
import { Avatar } from '@/components/ui/Avatar';
import { GroupedList, type GroupedListRow } from '@/components/ui/GroupedList';
import type { NativeSettingsProps } from './NativeSettings.types';

const icons: Record<string, GroupedListRow['icon']> = {
  general: { ios: 'gearshape', android: General },
  members: { ios: 'person.2', android: Members },
  permissions: { ios: 'lock.shield', android: Permissions },
  agents: { ios: 'cpu', android: Agents },
  skills: { ios: 'books.vertical', android: Skills },
  automations: { ios: 'bolt', android: Automations },
  connectors: { ios: 'puzzlepiece.extension', android: Connectors },
  memory: { ios: 'brain.head.profile', android: Memory },
  activity: { ios: 'clock.arrow.circlepath', android: Activity },
  usage: { ios: 'chart.bar', android: Usage },
  archive: { ios: 'archivebox', android: Archive },
};

/** Settings owns its domain data and actions; GroupedList owns every platform's presentation. */
export function NativeSettings({ name, email, image, onAccount, groups, onSignOut, signingOut, error }: NativeSettingsProps) {
  return <GroupedList testID="settings-groups" sections={[
    { id: 'account', title: 'Account', rows: [{
      id: 'account', title: name, subtitle: email && email !== name ? email : undefined,
      leading: <Avatar name={name} image={image} />, onPress: onAccount,
      accessibilityHint: 'Edit your profile and preferences',
    }] },
    ...groups.map(group => ({ id: group.rows[0]?.id ?? group.title, title: group.title, rows: group.rows.map(row => ({
      id: row.id, title: row.label, icon: icons[row.id], onPress: row.onPress,
      accessibilityHint: row.description, testID: `settings-${row.id}`,
    })) })),
    { id: 'session', footer: error ?? undefined, rows: [{
      id: 'sign-out', testID: 'settings-sign-out', title: signingOut ? 'Signing out…' : 'Sign out',
      onPress: onSignOut, disabled: signingOut, destructive: true,
    }] },
  ]} />;
}
