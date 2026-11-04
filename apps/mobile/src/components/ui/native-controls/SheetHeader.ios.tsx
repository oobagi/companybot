import { Button, Host, HStack, Image, Spacer, Text } from '@expo/ui/swift-ui';
import { accessibilityAddTraits, accessibilityLabel, buttonBorderShape, buttonStyle, controlSize, disabled, font, foregroundStyle, frame, imageScale, lineLimit, tint } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '@/design';
import type { SheetHeaderProps } from './SheetHeader.types';

export function SheetHeader({ title, onClose, busy = false }: SheetHeaderProps) {
  const { colors, dark, sizes, spacing } = useTheme();
  return <Host matchContents={{ vertical: true }} colorScheme={dark ? 'dark' : 'light'} ignoreSafeArea="all" style={{ minHeight: sizes.touch }}>
    <HStack spacing={spacing.sm}>
      <Text modifiers={[font({ textStyle: 'headline' }), foregroundStyle(colors.text), lineLimit(2), accessibilityAddTraits(['isHeader'])]}>{title}</Text>
      <Spacer />
      <Button role="close" onPress={busy ? undefined : onClose} modifiers={[buttonStyle('bordered'), buttonBorderShape('circle'), controlSize('regular'), tint(colors.muted), disabled(busy), accessibilityLabel(`Close ${title}`), frame({ minWidth: sizes.touch, minHeight: sizes.touch })]}>
        <Image systemName="xmark" modifiers={[imageScale('medium'), font({ textStyle: 'body', weight: 'semibold' })]} />
      </Button>
    </HStack>
  </Host>;
}
