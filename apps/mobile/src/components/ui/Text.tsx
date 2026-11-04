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
