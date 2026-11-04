import { Button, Form, Host, HStack, Image, RNHostView, Section, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import { accessibilityHidden, accessibilityHint, accessibilityLabel, contentShape, disabled, font, foregroundStyle, frame, shapes } from '@expo/ui/swift-ui/modifiers';
import type { ComponentProps } from 'react';
import { Avatar } from '@/components/ui';
import { useTheme } from '@/design';
import type { NativeSettingsProps } from './NativeSettings.types';

const symbols: Record<string, ComponentProps<typeof Image>['systemName']> = {
  general: 'gearshape',
  members: 'person.2',
  permissions: 'lock.shield',
  agents: 'cpu',
  skills: 'books.vertical',
  automations: 'bolt',
  connectors: 'puzzlepiece.extension',
  memory: 'brain.head.profile',
  activity: 'clock.arrow.circlepath',
  usage: 'chart.bar',
  archive: 'archivebox',
};

/** Let Form own row heights, insets and grouped surfaces; content uses Dynamic Type. */
export function NativeSettings({ name, email, image, onAccount, groups, onSignOut, signingOut, error }: NativeSettingsProps) {
  const { colors, dark, sizes, spacing } = useTheme();
  const disclosure = <Image systemName="chevron.forward" modifiers={[font({ textStyle: 'caption', weight: 'semibold' }), foregroundStyle(colors.muted), accessibilityHidden()]} />;
  const rowShape = contentShape(shapes.rectangle());
  return <Host style={{ flex: 1 }} colorScheme={dark ? 'dark' : 'light'} seedColor={colors.link}>
    <Form testID="settings-groups">
      <Section title="Account">
        <Button onPress={onAccount} modifiers={[accessibilityLabel(email && email !== name ? `${name}, ${email}` : name), accessibilityHint('Edit your profile and preferences')]}>
          <HStack spacing={spacing.md} modifiers={[rowShape]}>
            <RNHostView matchContents><Avatar name={name} image={image} /></RNHostView>
            <VStack alignment="leading" spacing={spacing.xs}>
              <Text modifiers={[font({ textStyle: 'body' }), foregroundStyle(colors.text)]}>{name}</Text>
              {email && email !== name && <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(colors.muted)]}>{email}</Text>}
            </VStack>
            <Spacer />
            {disclosure}
          </HStack>
        </Button>
      </Section>
      {groups.map(group => <Section key={group.rows[0]?.id ?? group.title} title={group.title}>
        {group.rows.map(row => <Button key={row.id} testID={`settings-${row.id}`} onPress={row.onPress} modifiers={[accessibilityLabel(row.label), accessibilityHint(row.description)]}>
          <HStack spacing={spacing.md} modifiers={[rowShape]}>
            <Image systemName={symbols[row.id] ?? 'gearshape'} modifiers={[font({ textStyle: 'body' }), foregroundStyle(colors.muted), frame({ width: sizes.icon }), accessibilityHidden()]} />
            <Text modifiers={[font({ textStyle: 'body' }), foregroundStyle(colors.text)]}>{row.label}</Text>
            <Spacer />
            {disclosure}
          </HStack>
        </Button>)}
      </Section>)}
      <Section footer={error ? <Text modifiers={[foregroundStyle(colors.danger)]}>{error}</Text> : undefined}>
        <Button label={signingOut ? 'Signing out…' : 'Sign out'} onPress={signingOut ? undefined : onSignOut} modifiers={[disabled(signingOut)]} testID="settings-sign-out" />
      </Section>
    </Form>
  </Host>;
}
