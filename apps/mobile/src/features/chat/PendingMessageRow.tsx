import { ActivityIndicator, View } from 'react-native';
import { Stack, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { MessageAuthor, MessageHeader } from './MessageHeader';

/** Local message presentation has no server actions or profile/navigation dependencies. */
export function PendingMessageRow({ name, image, text, files, dayLabel }: { name: string; image?: string | null; text: string; files: number; dayLabel?: string }) {
  const { colors, sizes, spacing } = useTheme();
  return <View style={{ paddingHorizontal: sizes.gutter, paddingVertical: spacing.md, gap: spacing.xs }}>
    {dayLabel && <Text variant="caption" tone="muted" accessibilityRole="header" style={{ textAlign: 'center', paddingVertical: spacing.sm }}>{dayLabel}</Text>}
    <MessageHeader><MessageAuthor name={name} image={image} /></MessageHeader>
    {!!text && <Text>{text}</Text>}
    <Stack horizontal gap="xs">
      <ActivityIndicator size="small" color={colors.muted} />
      <Text variant="caption" tone="muted" accessibilityLiveRegion="polite" style={{ flex: 1 }}>{files ? `Sending with ${files} ${files === 1 ? 'attachment' : 'attachments'}…` : 'Sending…'}</Text>
    </Stack>
  </View>;
}
