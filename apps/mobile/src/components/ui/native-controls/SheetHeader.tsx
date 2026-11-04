import { Stack } from '../Layout';
import { Text } from '../Text';
import { IconButton } from '../Button';
import type { SheetHeaderProps } from './SheetHeader.types';

export function SheetHeader({ title, onClose, busy = false }: SheetHeaderProps) {
  return <Stack horizontal gap="sm"><Text variant="label" accessibilityRole="header" style={{ flex: 1 }}>{title}</Text><IconButton label={`Close ${title}`} onPress={onClose} disabled={busy}><Text variant="heading">×</Text></IconButton></Stack>;
}
