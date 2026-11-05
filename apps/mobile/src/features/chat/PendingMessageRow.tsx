import { ActivityIndicator, View } from 'react-native';
import { Avatar, Stack, Text } from '@/components/ui';
import { useTheme } from '@/design';

/** Local message presentation has no server actions or profile/navigation dependencies. */
export function PendingMessageRow({ name, image, text, files, dayLabel }: { name: string; image?: string | null; text: string; files: number; dayLabel?: string }) {
  const { colors, spacing } = useTheme();
  return <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm }}>
    {dayLabel && <Text variant="caption" tone="muted" accessibilityRole="header" style={{ textAlign: 'center', paddingVertical: spacing.sm }}>{dayLabel}</Text>}
    <Stack horizontal gap="sm">
      <Avatar name={name} image={image} size="sm" />
      <Text variant="label" style={{ flex: 1 }}>{name}</Text>
    </Stack>
    {!!text && <Text>{text}</Text>}
    <Stack horizontal gap="xs">
      <ActivityIndicator size="small" color={colors.muted} />
      <Text variant="caption" tone="muted" accessibilityLiveRegion="polite" style={{ flex: 1 }}>{files ? `Sending with ${files} ${files === 1 ? 'attachment' : 'attachments'}…` : 'Sending…'}</Text>
    </Stack>
  </View>;
}
