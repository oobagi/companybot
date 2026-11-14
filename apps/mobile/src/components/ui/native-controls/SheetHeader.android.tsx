import { useState } from 'react';
import { Host } from '@expo/ui';
import { CircularProgressIndicator, Column, Icon, IconButton, Row, Spacer, Text, TextButton } from '@expo/ui/jetpack-compose';
import { defaultMinSize, fillMaxWidth, semantics, size, weight, width } from '@expo/ui/jetpack-compose/modifiers';
import Close from '@expo/material-symbols/close.xml';
import { useWindowDimensions } from 'react-native';
import { useTheme } from '@/design';
import type { SheetHeaderProps } from './SheetHeader.types';

export function SheetHeader({ title, onClose, busy = false, submit }: SheetHeaderProps) {
  const { colors, dark, sizes, spacing } = useTheme();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const [availableWidth, setAvailableWidth] = useState<number>();
  const slotWidth = submit ? 80 * fontScale : sizes.touch;
  const stacked = fontScale >= 1.5 || (availableWidth ?? windowWidth - spacing.lg * 2) < slotWidth * 2 + 120 * fontScale + spacing.sm * 2;
  const heading = <Text color={colors.text} style={{ typography: 'titleMedium', textAlign: 'center' }} modifiers={stacked ? [fillMaxWidth()] : [weight(1)]}>{title}</Text>;
  return <Host onLayout={event => setAvailableWidth(event.nativeEvent.layout.width)} matchContents={{ vertical: true }} colorScheme={dark ? 'dark' : 'light'} style={{ minHeight: sizes.touch }}>
    <Column verticalArrangement={{ spacedBy: spacing.xs }} modifiers={[fillMaxWidth()]}>
      {stacked && heading}
      <Row verticalAlignment="center" horizontalArrangement={{ spacedBy: spacing.sm }} modifiers={[fillMaxWidth()]}>
        {submit ? <TextButton enabled={!busy} onClick={busy ? undefined : onClose} modifiers={[...(stacked ? [] : [width(slotWidth)]), defaultMinSize({ minHeight: sizes.touch })]}><Text style={{ typography: 'bodyLarge' }}>Cancel</Text></TextButton> : <Spacer modifiers={[width(slotWidth)]} />}
        {stacked ? <Spacer modifiers={[weight(1)]} /> : heading}
        {submit ? <TextButton enabled={!busy && !submit.disabled} onClick={busy || submit.disabled ? undefined : submit.onPress} modifiers={[...(stacked ? [] : [width(slotWidth)]), defaultMinSize({ minHeight: sizes.touch }), semantics({ contentDescription: busy ? 'Saving' : submit.label ?? 'Done' })]}>
          {busy ? <CircularProgressIndicator modifiers={[size(sizes.icon, sizes.icon)]} /> : <Text style={{ typography: 'bodyLarge', fontWeight: '600' }}>{submit.label ?? 'Done'}</Text>}
        </TextButton> : <IconButton enabled={!busy} onClick={busy ? undefined : onClose} modifiers={[size(sizes.touch, sizes.touch)]}>
          <Icon source={Close} size={sizes.icon} tint={colors.muted} contentDescription={`Close ${title}`} />
        </IconButton>}
      </Row>
    </Column>
  </Host>;
}
