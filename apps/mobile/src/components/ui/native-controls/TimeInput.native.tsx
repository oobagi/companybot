import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useState } from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { useTheme } from '@/design';
import { ListRow } from '../ListRow';
import { Text } from '../Text';
import type { TimeInputProps } from './TimeInput.types';
import { localTimeToWallClock, wallClockTimeToLocal } from './wallClockTime';

export function TimeInput({ label, value, onChange, disabled = false }: TimeInputProps) {
  const [open, setOpen] = useState(false);
  const { colors, dark, sizes, spacing } = useTheme();
  const { fontScale, width } = useWindowDimensions();
  const stacked = fontScale >= 1.4 || width < 360;
  const date = wallClockTimeToLocal(value);
  const picker = <DateTimePicker
    key={fontScale}
    mode="time"
    value={date ?? wallClockTimeToLocal('09:00')!}
    display={Platform.OS === 'ios' ? 'compact' : 'default'}
    presentation="dialog"
    disabled={disabled}
    accentColor={colors.link}
    themeVariant={dark ? 'dark' : 'light'}
    onValueChange={(_event, next) => {
      if (!disabled) onChange(localTimeToWallClock(next));
      setOpen(false);
    }}
    onDismiss={() => setOpen(false)}
  />;

  if (Platform.OS === 'android') return <View>
    <ListRow title={label} value={date?.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) ?? value} disabled={disabled} onPress={() => setOpen(true)} />
    {open && !disabled && picker}
  </View>;

  return <View style={{ minHeight: sizes.touch + spacing.sm, flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'flex-start' : 'center', gap: spacing.sm, paddingVertical: spacing.md }}>
    <Text style={{ flex: stacked ? undefined : 1, opacity: disabled ? 0.5 : 1 }}>{label}</Text>
    {picker}
  </View>;
}
