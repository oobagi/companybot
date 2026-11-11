import { Text as NativeText, type TextProps as NativeTextProps } from 'react-native';
import { useTheme, type TextVariant } from '@/design';

export type TextProps = NativeTextProps & {
  variant?: TextVariant;
  tone?: 'default' | 'muted' | 'link' | 'danger' | 'inverse' | 'success';
};

export function Text({ variant = 'body', tone = 'default', style, ...props }: TextProps) {
  const { colors, typography } = useTheme();
  const color = tone === 'default' ? colors.text : tone === 'inverse' ? colors.onPrimary : colors[tone];
  return <NativeText {...props} style={[typography[variant], { color }, style]} />;
}

/** Nested runs inherit size, weight and color from their enclosing paragraph. */
export function InlineText({ tone, style, ...props }: Omit<TextProps, 'variant'>) {
  const { colors } = useTheme();
  const color = tone === undefined ? undefined : tone === 'default' ? colors.text : tone === 'inverse' ? colors.onPrimary : colors[tone];
  return <NativeText {...props} style={[color !== undefined && { color }, style]} />;
}
