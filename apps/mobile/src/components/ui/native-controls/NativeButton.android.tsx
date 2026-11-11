import { Button, CircularProgressIndicator, Host, OutlinedButton, RNHostView, Row, Text, TextButton } from '@expo/ui/jetpack-compose';
import { defaultMinSize, semantics, size, testID as nativeTestID } from '@expo/ui/jetpack-compose/modifiers';
import { useTheme } from '@/design';
import type { ButtonProps } from '../Button';

/** Material buttons retain native ripple, TalkBack state and scalable sp typography. */
export function NativeButton({ label, variant = 'primary', loading = false, disabled, leading, style, onPress, accessibilityLabel, accessibilityHint, accessibilityState, testID }: ButtonProps) {
  const { colors, dark, spacing, sizes, typography } = useTheme();
  const inactive = !!disabled || loading;
  const color = variant === 'primary' ? colors.onPrimary : variant === 'danger' ? colors.danger : colors.text;
  const Control = variant === 'primary' ? Button : variant === 'ghost' ? TextButton : OutlinedButton;
  const description = [accessibilityLabel ?? label, accessibilityState?.selected && 'Selected', (loading || accessibilityState?.busy) && 'In progress', accessibilityHint].filter(Boolean).join('. ');
  return <Host matchContents colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={[{ flexShrink: 1, minHeight: sizes.touch, maxWidth: '100%' }, style]}>
    <Control enabled={!inactive} onClick={inactive ? undefined : onPress}
      colors={{ contentColor: color, ...(variant === 'primary' ? { containerColor: colors.primary } : variant === 'danger' ? { containerColor: colors.dangerSurface } : {}) }}
      contentPadding={{ start: spacing.lg, end: spacing.lg, top: spacing.md, bottom: spacing.md }}
      modifiers={[defaultMinSize({ minHeight: sizes.touch, minWidth: sizes.touch }), semantics({ contentDescription: description }), ...(testID ? [nativeTestID(testID)] : [])]}>
      <Row horizontalArrangement={{ spacedBy: spacing.sm }} verticalAlignment="center">
        {loading ? <CircularProgressIndicator color={color} modifiers={[size(sizes.icon, sizes.icon)]} /> : leading ? <RNHostView matchContents><>{leading}</></RNHostView> : null}
        <Text color={color} style={{ typography: 'labelLarge', fontSize: typography.label.fontSize, fontWeight: typography.label.fontWeight, textAlign: 'center' }}>{label}</Text>
      </Row>
    </Control>
  </Host>;
}
