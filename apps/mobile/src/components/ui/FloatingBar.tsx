import type { PropsWithChildren } from 'react';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { View } from 'react-native';
import { useTheme } from '@/design';

/** One floating control surface. Content and forms stay on the page background. */
export function FloatingBar({ children }: PropsWithChildren) {
  const { colors, dark, spacing } = useTheme();
  const style = { borderRadius: 28, padding: spacing.xs };
  if (process.env.EXPO_OS === 'ios' && isLiquidGlassAvailable()) {
    return <GlassView glassEffectStyle="regular" colorScheme={dark ? 'dark' : 'light'} style={style}>{children}</GlassView>;
  }
  return <View style={[style, { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border }]}>{children}</View>;
}
