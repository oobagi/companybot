import { useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useTheme } from '@/design';
import { Text } from '../Text';
import { Button, IconButton } from '../Button';
import type { SheetHeaderProps } from './SheetHeader.types';

export function SheetHeader({ title, onClose, busy = false, submit }: SheetHeaderProps) {
  const { spacing, sizes } = useTheme();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const [availableWidth, setAvailableWidth] = useState<number>();
  const slotWidth = submit ? 96 * fontScale : sizes.touch;
  const stacked = fontScale >= 1.5 || (availableWidth ?? windowWidth - spacing.lg * 2) < slotWidth * 2 + 120 * fontScale + spacing.sm * 2;
  const heading = <Text variant="label" accessibilityRole="header" style={{ flex: stacked ? undefined : 1, textAlign: 'center' }}>{title}</Text>;
  return <View onLayout={event => setAvailableWidth(event.nativeEvent.layout.width)} style={{ gap: spacing.xs }}>
    {stacked && heading}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <View style={{ width: stacked ? undefined : slotWidth, maxWidth: '45%' as const }}>{submit && <Button label="Cancel" variant="ghost" onPress={onClose} disabled={busy} />}</View>
      {stacked ? <View style={{ flex: 1 }} /> : heading}
      <View style={{ width: stacked ? undefined : slotWidth, maxWidth: '45%' as const }}>{submit ? <Button label={submit.label ?? "Done"} variant="ghost" onPress={submit.onPress} disabled={submit.disabled} loading={busy} /> : <IconButton label={`Close ${title}`} onPress={onClose} disabled={busy}><Text variant="heading">×</Text></IconButton>}</View>
    </View>
  </View>;
}
