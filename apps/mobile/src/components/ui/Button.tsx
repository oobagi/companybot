import type { ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/design';
import { Text } from './Text';
import { NativeButton } from './native-controls/NativeButton';

export type ButtonProps = Omit<PressableProps, 'children' | 'style' | 'onPress'> & {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
  leading?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function Button({ label, variant = 'primary', loading = false, disabled, leading, style, accessibilityState, ...props }: ButtonProps) {
  const { colors, spacing, radii, sizes } = useTheme();
  if (Platform.OS !== 'web') return <NativeButton {...props} label={label} variant={variant} loading={loading} disabled={disabled} leading={leading} style={style} accessibilityState={accessibilityState} />;
  const inactive = disabled || loading;
  const color = variant === 'primary' ? colors.onPrimary : variant === 'danger' ? colors.danger : colors.text;
  const backgroundColor = variant === 'primary' ? colors.primary : variant === 'danger' ? colors.dangerSurface : variant === 'secondary' ? colors.surface : 'transparent';
  return (
    <Pressable {...props} accessibilityRole="button" accessibilityState={{ ...accessibilityState, disabled: !!inactive, busy: loading }} disabled={inactive}
      style={({ pressed }) => [styles.button, { minHeight: sizes.touch, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm, borderRadius: radii.md, backgroundColor, borderColor: variant === 'secondary' ? colors.border : 'transparent', opacity: inactive ? 0.5 : pressed ? 0.7 : 1 }, style]}>
      {loading ? <ActivityIndicator color={color} accessibilityElementsHidden importantForAccessibility="no" /> : leading}
      <Text variant="label" style={{ color, textAlign: 'center', flexShrink: 1 }}>{label}</Text>
    </Pressable>
  );
}

export type IconButtonProps = Omit<PressableProps, 'style'> & { label: string; style?: StyleProp<ViewStyle> };
export function IconButton({ label, children, disabled, style, accessibilityState, ...props }: IconButtonProps) {
  const { colors, sizes, radii } = useTheme();
  return (
    <Pressable {...props} accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ ...accessibilityState, disabled: !!disabled }} disabled={disabled}
      style={({ pressed }) => [styles.button, { width: sizes.touch, minHeight: sizes.touch, borderRadius: radii.md, backgroundColor: pressed ? colors.pressed : 'transparent', opacity: disabled ? 0.5 : 1 }, style]}>
      {children}
    </Pressable>
  );
}
const styles = StyleSheet.create({ button: { alignItems: 'center', justifyContent: 'center', flexDirection: 'row', borderWidth: 1, borderColor: 'transparent' } });
