import { Host, HStack, Image, List, Spacer, Text } from '@expo/ui/swift-ui';
import { accessibilityLabel, disabled, environment, font, foregroundStyle, listStyle } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '@/design';
import type { ReorderListProps } from './ReorderList.types';

export function ReorderList({ items, disabled: locked, currentId, onMove }: ReorderListProps) {
  const { colors, dark, spacing } = useTheme();
  return <Host style={{ flex: 1 }} colorScheme={dark ? 'dark' : 'light'}>
    <List modifiers={[listStyle('plain'), environment('editMode', 'active'), disabled(locked)]}>
      <List.ForEach data={items} keyExtractor={item => item._id} onMove={locked ? undefined : onMove}>
        {({ item }) => <HStack spacing={spacing.sm} modifiers={[accessibilityLabel(`${item.title}${item._id === currentId ? ', current view' : ''}`)]}>
          <Text modifiers={[font({ textStyle: 'body' }), foregroundStyle(colors.text)]}>{item.title}</Text>
          <Spacer />
          {item._id === currentId && <Image systemName="checkmark" color={colors.link} modifiers={[font({ textStyle: 'body' })]} />}
        </HStack>}
      </List.ForEach>
    </List>
  </Host>;
}
