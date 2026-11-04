import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useState } from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { useTheme } from '@/design';
import { ListRow } from '../ListRow';
import { Text } from '../Text';
import { calendarDateToLocal, localDateToCalendar } from './calendarDate';
import type { DateInputProps } from './DateInput.types';

export function DateInput({ label, value, onChange, disabled = false }: DateInputProps) {
  const [open, setOpen] = useState(false);
  const { dark, colors, spacing, sizes } = useTheme();
  const { fontScale } = useWindowDimensions();
  const date = calendarDateToLocal(value) ?? new Date();
  const picker = <DateTimePicker key={fontScale} mode="date" value={date} display={Platform.OS === 'ios' ? 'compact' : 'default'} presentation="dialog" disabled={disabled} accentColor={colors.link} themeVariant={dark ? 'dark' : 'light'}
    onValueChange={(_event, next) => { if (!disabled) onChange(localDateToCalendar(next)); setOpen(false); }} onDismiss={() => setOpen(false)} />;
  const displayDate = calendarDateToLocal(value)?.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) ?? value;
  if (Platform.OS === 'android') return <View><ListRow title={label} value={displayDate} disabled={disabled} onPress={() => setOpen(true)} />{open && !disabled && picker}</View>;
  return <View style={{ minHeight: sizes.touch, flexDirection: fontScale >= 1.4 ? 'column' : 'row', alignItems: fontScale >= 1.4 ? 'flex-start' : 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}><Text style={{ flex: fontScale >= 1.4 ? undefined : 1 }}>{label}</Text>{picker}</View>;
}
