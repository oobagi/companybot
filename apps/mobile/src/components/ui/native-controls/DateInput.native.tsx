import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useState } from 'react';
import { Platform, View } from 'react-native';
import { formatDate } from '@companybot/core/records';
import { useTheme } from '@/design';
import { ListRow } from '../ListRow';
import { Text } from '../Text';
import { calendarDateToLocal, localDateToCalendar } from './calendarDate';
import type { DateInputProps } from './DateInput.types';

export function DateInput({ label, value, onChange, disabled = false }: DateInputProps) {
  const [open, setOpen] = useState(false);
  const { dark, colors, spacing } = useTheme();
  const date = calendarDateToLocal(value) ?? new Date();
  const picker = <DateTimePicker mode="date" value={date} display={Platform.OS === 'ios' ? 'inline' : 'default'} presentation="dialog" disabled={disabled} accentColor={colors.link} themeVariant={dark ? 'dark' : 'light'}
    onValueChange={(_event, next) => { if (!disabled) onChange(localDateToCalendar(next)); setOpen(false); }} onDismiss={() => setOpen(false)} />;
  if (Platform.OS === 'android') return <View><ListRow title={label} description={formatDate(value)} disabled={disabled} onPress={() => setOpen(true)} />{open && !disabled && picker}</View>;
  return <View style={{ gap: spacing.sm }}><Text variant="label">{label}</Text>{picker}</View>;
}
