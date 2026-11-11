import { Button, Host, HStack, ProgressView, RNHostView, Text } from '@expo/ui/swift-ui';
import { accessibilityAddTraits, accessibilityHint, accessibilityLabel, accessibilityValue, buttonStyle, contentShape, controlSize, disabled, font, foregroundStyle, frame, shapes, tint } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '@/design';
import type { ButtonProps } from '../Button';

/** SwiftUI owns interaction, pressed/disabled appearance and Dynamic Type. */
export function NativeButton({ label, variant = 'primary', loading = false, disabled: isDisabled, leading, style, onPress, accessibilityLabel: spokenLabel, accessibilityHint: hint, accessibilityState, testID }: ButtonProps) {
  const { colors, dark, spacing, sizes } = useTheme();
  const inactive = !!isDisabled || loading;
  // SwiftUI replaces the prominent fill while disabled; its content must no longer
  // use the white foreground intended for an active blue button.
  const color = inactive ? colors.muted : variant === 'primary' ? colors.onPrimary : variant === 'danger' ? colors.danger : colors.text;
  return <Host matchContents colorScheme={dark ? 'dark' : 'light'} ignoreSafeArea="all" style={[{ flexShrink: 1, minHeight: sizes.touch, maxWidth: '100%' }, style]}>
    <Button onPress={inactive ? undefined : onPress} role={variant === 'danger' ? 'destructive' : 'default'} testID={testID} modifiers={[
      buttonStyle(variant === 'primary' ? 'borderedProminent' : variant === 'ghost' ? 'plain' : 'bordered'),
      controlSize('large'), tint(variant === 'danger' ? colors.danger : colors.primary), disabled(inactive),
      frame({ minHeight: sizes.touch, minWidth: sizes.touch }), contentShape(shapes.rectangle()),
      accessibilityLabel(spokenLabel ?? label),
      ...(hint ? [accessibilityHint(hint)] : []),
      ...(loading || accessibilityState?.busy ? [accessibilityValue('In progress')] : []),
      ...(accessibilityState?.selected ? [accessibilityAddTraits(['isSelected'])] : []),
    ]}>
      <HStack spacing={spacing.sm}>
        {loading ? <ProgressView modifiers={[controlSize('small'), tint(color)]} /> : leading ? <RNHostView matchContents><>{leading}</></RNHostView> : null}
        <Text modifiers={[font({ textStyle: 'body', weight: 'semibold' }), foregroundStyle(color)]}>{label}</Text>
      </HStack>
    </Button>
  </Host>;
}
