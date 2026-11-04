import { Host, Icon, IconButton, Row, Text } from '@expo/ui/jetpack-compose';
import { fillMaxWidth, size, weight } from '@expo/ui/jetpack-compose/modifiers';
import Close from '@expo/material-symbols/close.xml';
import { useTheme } from '@/design';
import type { SheetHeaderProps } from './SheetHeader.types';

export function SheetHeader({ title, onClose, busy = false }: SheetHeaderProps) {
  const { colors, dark, sizes, spacing } = useTheme();
  return <Host matchContents={{ vertical: true }} colorScheme={dark ? 'dark' : 'light'} style={{ minHeight: sizes.touch }}>
    <Row verticalAlignment="center" horizontalArrangement={{ spacedBy: spacing.sm }} modifiers={[fillMaxWidth()]}>
      <Text color={colors.text} style={{ typography: 'titleMedium' }} maxLines={2} modifiers={[weight(1)]}>{title}</Text>
      <IconButton enabled={!busy} onClick={busy ? undefined : onClose} modifiers={[size(sizes.touch, sizes.touch)]}>
        <Icon source={Close} size={sizes.icon} tint={colors.muted} contentDescription={`Close ${title}`} />
      </IconButton>
    </Row>
  </Host>;
}
