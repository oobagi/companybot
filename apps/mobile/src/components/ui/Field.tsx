import { useId, useState } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { useTheme } from '@/design';
import { Text } from './Text';

export type FieldProps = TextInputProps & { label: string; error?: string; hint?: string };
export function Field({ label, error, hint, style, onFocus, onBlur, editable = true, ...props }: FieldProps) {
  const { colors, radii, spacing, sizes, typography } = useTheme();
  const id = useId();
  const [focused, setFocused] = useState(false);
  return <View style={{ gap: spacing.sm }}>
    <Text nativeID={id} variant="label">{label}</Text>
    <TextInput {...props} editable={editable} accessibilityLabel={props.accessibilityLabel ?? label} accessibilityLabelledBy={id}
      accessibilityHint={error ?? hint ?? props.accessibilityHint} placeholderTextColor={colors.muted} selectionColor={colors.link} underlineColorAndroid="transparent"
      onFocus={(event) => { setFocused(true); onFocus?.(event); }} onBlur={(event) => { setFocused(false); onBlur?.(event); }}
      style={[typography.body, { minHeight: props.multiline ? sizes.touch * 2 : sizes.touch, borderWidth: 1, borderColor: error ? colors.danger : focused ? colors.link : colors.border, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.md, backgroundColor: colors.elevated, color: colors.text, opacity: editable ? 1 : 0.6, textAlignVertical: props.multiline ? 'top' : 'center' }, style]} />
    {error ? <Text variant="caption" tone="danger" accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text> : hint ? <Text variant="caption" tone="muted">{hint}</Text> : null}
  </View>;
}
