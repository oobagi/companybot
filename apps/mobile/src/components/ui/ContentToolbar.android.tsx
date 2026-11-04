import { Host, Icon, IconButton, Row } from '@expo/ui/jetpack-compose';
import { fillMaxWidth, size } from '@expo/ui/jetpack-compose/modifiers';
import { View } from 'react-native';
import { useTheme } from '@/design';
import { ContentToolbarFrame } from './ContentToolbarFrame';
import type { ContentToolbarProps } from './ContentToolbar.types';
import { ContentToolbarOverflow, toolbarDirectActionLimit } from './ContentToolbarOverflow';

export function ContentToolbar({ actions, status, busy = false, accessibilityLabel }: ContentToolbarProps) {
  const { colors, dark, sizes, spacing } = useTheme();
  return <ContentToolbarFrame status={status} busy={busy} accessibilityLabel={accessibilityLabel}>
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
    <Host matchContents={{ vertical: true }} colorScheme={dark ? 'dark' : 'light'} style={{ flex: 1, minHeight: sizes.touch }}>
      <Row verticalAlignment="center" horizontalArrangement={{ spacedBy: spacing.sm }} modifiers={[fillMaxWidth()]}>
        {actions.slice(0, toolbarDirectActionLimit).map((action) => {
          const inactive = busy || !!action.disabled;
          return <IconButton key={action.id} enabled={!inactive} onClick={inactive ? undefined : action.onPress} colors={{ contentColor: colors.text, disabledContentColor: colors.muted }} modifiers={[size(sizes.touch, sizes.touch)]}>
            <Icon source={action.icon.android} size={sizes.icon} contentDescription={action.label} />
          </IconButton>;
        })}
      </Row>
    </Host>
    <ContentToolbarOverflow actions={actions} busy={busy} accessibilityLabel={accessibilityLabel} />
    </View>
  </ContentToolbarFrame>;
}
