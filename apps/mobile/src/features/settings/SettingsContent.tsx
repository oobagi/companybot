import { Avatar } from '@/components/ui/Avatar';
import { SettingsList } from '@/components/ui/SettingsList';
import { ActivityIcon, AgentIcon, ArchiveIcon, AutomationIcon, ConnectorIcon, MembersIcon, MemoryIcon, PermissionsIcon, SettingsIcon, SkillIcon, UsageIcon } from '@/design/icons';
import { useTheme } from '@/design';
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

const icons = { general: SettingsIcon, members: MembersIcon, permissions: PermissionsIcon, agents: AgentIcon, skills: SkillIcon, automations: AutomationIcon, connectors: ConnectorIcon, memory: MemoryIcon, activity: ActivityIcon, usage: UsageIcon, archive: ArchiveIcon };

/** Domain data and callbacks composed from the shared custom settings library. */
export function SettingsContent({ name, email, image, onAccount, groups, onSignOut, signingOut, error }: SettingsContentProps) {
  const { colors, sizes } = useTheme();
  return <SettingsList testID="settings-groups" sections={[
    { id: 'account', rows: [{
      id: 'account', title: name, subtitle: email && email !== name ? email : undefined,
      leading: <Avatar name={name} image={image} />, onPress: onAccount,
      accessibilityHint: 'Edit your profile and preferences',
    }] },
    ...groups.map(group => ({ id: group.rows[0]?.id ?? group.title, title: group.title, rows: group.rows.map(row => {
      const Icon = icons[row.id as keyof typeof icons];
      return ({
      id: row.id, title: row.label, leading: Icon ? <Icon size={sizes.icon} color={colors.muted} /> : undefined, onPress: row.onPress,
      accessibilityHint: row.description, testID: `settings-${row.id}`,
    }); }) })),
    { id: 'session', footer: error ?? undefined, rows: [{
      id: 'sign-out', testID: 'settings-sign-out', title: signingOut ? 'Signing out…' : 'Sign out',
      onPress: onSignOut, disabled: signingOut, destructive: true,
    }] },
  ]} />;
}
