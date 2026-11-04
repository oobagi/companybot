import { useState } from 'react';
import { Image, View } from 'react-native';
import { useTheme } from '@/design';
import { Text } from './Text';

export type AvatarProps = { name: string; image?: string | null; agent?: boolean; size?: 'sm' | 'md' | 'lg' };
export function Avatar({ name, image, agent = false, size = 'md' }: AvatarProps) {
  const { colors, sizes, radii } = useTheme();
  const [broken, setBroken] = useState<string>();
  const dimension = sizes.avatar[size];
  const shape = { width: dimension, height: dimension, borderRadius: agent ? radii.md : radii.full };
  if (image && broken !== image) return <Image source={{ uri: image }} accessibilityLabel={name} style={shape} onError={() => setBroken(image)} resizeMode="cover" />;
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0] ?? '').join('').toUpperCase() || '?';
  return <View accessibilityLabel={name} accessible style={[shape, { alignItems: 'center', justifyContent: 'center', backgroundColor: agent ? colors.primary : colors.pressed }]}>
    <Text variant={size === 'lg' ? 'heading' : 'caption'} style={{ color: agent ? colors.onPrimary : colors.text }} maxFontSizeMultiplier={1.5}>{initials}</Text>
  </View>;
}

export function Badge({ label, tone = 'default' }: { label: string; tone?: 'default' | 'danger' | 'success' | 'warning' }) {
  const { colors, spacing, radii } = useTheme();
  const foreground = tone === 'default' ? colors.muted : colors[tone];
  const background = tone === 'default' ? colors.pressed : colors[`${tone}Surface`];
  return <View style={{ alignSelf: 'flex-start', backgroundColor: background, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: radii.sm }}><Text variant="caption" style={{ color: foreground }}>{label}</Text></View>;
}
