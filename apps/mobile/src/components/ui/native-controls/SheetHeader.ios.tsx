import { useState } from 'react';
import { Host } from '@expo/ui';
import { Button, HStack, ProgressView, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import { accessibilityAddTraits, accessibilityLabel, accessibilityValue, buttonStyle, controlSize, disabled, font, foregroundStyle, frame, multilineTextAlignment, tint } from '@expo/ui/swift-ui/modifiers';
import { useWindowDimensions } from 'react-native';
import { useTheme } from '@/design';
import type { SheetHeaderProps } from './SheetHeader.types';

export function SheetHeader({ title, onClose, busy = false, submit }: SheetHeaderProps) {
  const { colors, dark, sizes, spacing } = useTheme();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const [availableWidth, setAvailableWidth] = useState<number>();
  const slotWidth = submit ? 72 * fontScale : sizes.touch;
  const stacked = fontScale >= 1.5 || (availableWidth ?? windowWidth - spacing.lg * 2) < slotWidth * 2 + 120 * fontScale + spacing.sm * 2;
  const heading = <Text modifiers={[font({ textStyle: 'headline' }), foregroundStyle(colors.text), multilineTextAlignment('center'), accessibilityAddTraits(['isHeader']), frame({ maxWidth: Infinity })]}>{title}</Text>;
  return <Host onLayout={event => setAvailableWidth(event.nativeEvent.layout.width)} matchContents={{ vertical: true }} colorScheme={dark ? 'dark' : 'light'} ignoreSafeArea="all" style={{ minHeight: sizes.touch }}>
    <VStack spacing={spacing.xs}>
      {stacked && heading}
      <HStack spacing={spacing.sm}>
        {submit ? <Button role="cancel" label="Cancel" onPress={busy ? undefined : onClose} modifiers={[buttonStyle('plain'), font({ textStyle: 'body' }), tint(colors.link), disabled(busy), ...(stacked ? [] : [frame({ width: slotWidth })]), frame({ minHeight: sizes.touch })]} /> : <Spacer modifiers={[frame({ width: slotWidth })]} />}
        {stacked ? <Spacer /> : heading}
        {submit ? <Button onPress={busy || submit.disabled ? undefined : submit.onPress} modifiers={[buttonStyle('plain'), tint(colors.link), disabled(busy || !!submit.disabled), accessibilityLabel('Done'), ...(busy ? [accessibilityValue('Saving')] : []), ...(stacked ? [] : [frame({ width: slotWidth })]), frame({ minHeight: sizes.touch })]}>
          {busy ? <ProgressView modifiers={[controlSize('small')]} /> : <Text modifiers={[font({ textStyle: 'body', weight: 'semibold' })]}>Done</Text>}
        </Button> : <Button role="close" onPress={busy ? undefined : onClose} modifiers={[disabled(busy), accessibilityLabel(`Close ${title}`), ...(stacked ? [] : [frame({ width: slotWidth })]), frame({ minHeight: sizes.touch })]} />}
      </HStack>
    </VStack>
  </Host>;
}
