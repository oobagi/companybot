import { Avatar } from '@/components/ui/Avatar';
import { SettingsList, type SettingsRowData } from '@/components/ui/SettingsList';
type SettingsGroup = { title: string; rows: { id: string; label: string; description: string; onPress: () => void }[] };
type SettingsContentProps = {
  name: string;
  email?: string;
  image?: string | null;
  onAccount: () => void;
  groups: SettingsGroup[];
  onSignOut: () => void;
  signingOut: boolean;
  error?: string | null;
};

const icons: Record<string, SettingsRowData['icon']> = {
  general: { ios: 'gearshape', android: 'settings', web: 'settings' },
  members: { ios: 'person.2', android: 'group', web: 'group' },
  permissions: { ios: 'lock.shield', android: 'admin_panel_settings', web: 'admin_panel_settings' },
  agents: { ios: 'cpu', android: 'smart_toy', web: 'smart_toy' },
  skills: { ios: 'books.vertical', android: 'menu_book', web: 'menu_book' },
  automations: { ios: 'bolt', android: 'bolt', web: 'bolt' },
  connectors: { ios: 'puzzlepiece.extension', android: 'extension', web: 'extension' },
  memory: { ios: 'brain.head.profile', android: 'psychology', web: 'psychology' },
  activity: { ios: 'clock.arrow.circlepath', android: 'history', web: 'history' },
  usage: { ios: 'chart.bar', android: 'bar_chart', web: 'bar_chart' },
  archive: { ios: 'archivebox', android: 'archive', web: 'archive' },
};

/** Domain data and callbacks composed from the shared custom settings library. */
export function SettingsContent({ name, email, image, onAccount, groups, onSignOut, signingOut, error }: SettingsContentProps) {
  return <SettingsList testID="settings-groups" sections={[
    { id: 'account', rows: [{
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
