import { useState } from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { useTheme } from '@/design';
import { ListRow } from '../ListRow';
import { Text } from '../Text';
import { calendarDateToLocal, localDateToCalendar } from './calendarDate';
import type { DateInputProps } from './DateInput.types';
import { NativeDateTimePicker } from './NativeDateTimePicker';

export function DateInput({ label, value, onChange, disabled = false }: DateInputProps) {
  const [open, setOpen] = useState(false);
  const { spacing, sizes } = useTheme();
  const { fontScale } = useWindowDimensions();
  const date = calendarDateToLocal(value) ?? new Date();
  const picker = <NativeDateTimePicker key={fontScale} label={label} mode="date" value={date} disabled={disabled}
    onChange={next => { if (!disabled) onChange(localDateToCalendar(next)); setOpen(false); }} onDismiss={() => setOpen(false)} />;
  const displayDate = calendarDateToLocal(value)?.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) ?? value;
  if (Platform.OS === 'android') return <View><ListRow title={label} value={displayDate} disabled={disabled} onPress={() => setOpen(true)} />{open && !disabled && picker}</View>;
  return <View style={{ minHeight: sizes.touch, flexDirection: fontScale >= 1.4 ? 'column' : 'row', alignItems: fontScale >= 1.4 ? 'flex-start' : 'center', gap: spacing.sm, paddingVertical: spacing.sm }}><Text accessibilityElementsHidden style={{ flex: fontScale >= 1.4 ? undefined : 1 }}>{label}</Text>{picker}</View>;
}
