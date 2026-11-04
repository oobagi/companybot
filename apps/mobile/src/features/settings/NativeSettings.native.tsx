import { Button, FieldGroup, Host, ListItem, RNHostView, Text } from '@expo/ui';
import { frame } from '@expo/ui/swift-ui/modifiers';
import { defaultMinSize } from '@expo/ui/jetpack-compose/modifiers';
import type { ReactElement } from 'react';
import { I18nManager, Platform, Text as NativeText, View } from 'react-native';
import { Avatar } from '@/components/ui';
import { useTheme } from '@/design';
import type { NativeSettingsProps } from './NativeSettings.types';

// Universal ListItem wraps accessories in RNHostView on iOS; Compose needs an explicit bridge.
const accessory = (node: ReactElement) => Platform.OS === 'ios' ? node : <RNHostView matchContents>{node}</RNHostView>;

/** Expo FieldGroup renders a SwiftUI Form or a Material 3 grouped LazyColumn. */
export function NativeSettings({ name, email, image, onAccount, groups, onSignOut, signingOut, error }: NativeSettingsProps) {
  const { colors, dark, sizes, typography } = useTheme();
  const minimumTarget = Platform.OS === 'ios' ? [frame({ minHeight: sizes.touch })] : [defaultMinSize({ minHeight: sizes.touch })];
  const disclosure = accessory(<View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><NativeText style={[typography.heading, { color: colors.muted }]}>{I18nManager.isRTL ? '‹' : '›'}</NativeText></View>);
  return <Host style={{ flex: 1 }} colorScheme={dark ? 'dark' : 'light'} seedColor={colors.link}>
    <FieldGroup testID="settings-groups">
      <FieldGroup.Section title="Account">
        <ListItem onPress={onAccount} supportingText={email} leading={accessory(<Avatar name={name} image={image} />)} trailing={disclosure} modifiers={minimumTarget}>{name}</ListItem>
      </FieldGroup.Section>
      {groups.map(group => <FieldGroup.Section key={group.rows[0]?.id ?? group.title} title={group.title}>
        {group.rows.map(row => <ListItem key={row.id} testID={`settings-${row.id}`} onPress={row.onPress} trailing={disclosure} modifiers={minimumTarget}>{row.label}</ListItem>)}
      </FieldGroup.Section>)}
      <FieldGroup.Section>
        <Button label={signingOut ? 'Signing out…' : 'Sign out'} variant="text" disabled={signingOut} onPress={onSignOut} modifiers={minimumTarget} testID="settings-sign-out" />
        {error && <FieldGroup.SectionFooter><Text textStyle={{ color: colors.danger }}>{error}</Text></FieldGroup.SectionFooter>}
      </FieldGroup.Section>
    </FieldGroup>
  </Host>;
}
