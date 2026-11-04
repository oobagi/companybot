import { Button, Host, HStack, Image } from '@expo/ui/swift-ui';
import { accessibilityLabel, buttonStyle, disabled, frame, tint } from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';
import { useTheme } from '@/design';
import { ContentToolbarFrame } from './ContentToolbarFrame';
import type { ContentToolbarProps } from './ContentToolbar.types';
import { ContentToolbarOverflow, toolbarDirectActionLimit } from './ContentToolbarOverflow';

export function ContentToolbar({ actions, status, busy = false, accessibilityLabel: label }: ContentToolbarProps) {
  const { colors, dark, sizes, spacing } = useTheme();
  return <ContentToolbarFrame status={status} busy={busy} accessibilityLabel={label}>
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
    <Host matchContents={{ vertical: true }} colorScheme={dark ? 'dark' : 'light'} ignoreSafeArea="all" style={{ flex: 1, minHeight: sizes.touch }}>
      <HStack spacing={spacing.sm}>
        {actions.slice(0, toolbarDirectActionLimit).map((action) => {
          const inactive = busy || !!action.disabled;
          return <Button key={action.id} onPress={inactive ? undefined : action.onPress} modifiers={[buttonStyle('borderless'), tint(colors.text), disabled(inactive), accessibilityLabel(action.label)]}>
            <Image systemName={action.icon.ios} size={sizes.icon} modifiers={[frame({ minWidth: sizes.touch, minHeight: sizes.touch })]} />
          </Button>;
        })}
      </HStack>
    </Host>
    <ContentToolbarOverflow actions={actions} busy={busy} accessibilityLabel={label} />
    </View>
  </ContentToolbarFrame>;
}
