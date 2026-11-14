import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useTheme } from '@/design';
import type { NativeDateTimePickerProps } from './NativeDateTimePicker.types';

/** Android keeps Expo's native dialog; its trigger row owns the spoken label. */
export function NativeDateTimePicker({ mode, value, disabled, onChange, onDismiss }: NativeDateTimePickerProps) {
  const { colors, dark } = useTheme();
  return <DateTimePicker mode={mode} value={value} display="default" presentation="dialog" disabled={disabled}
    accentColor={colors.link} themeVariant={dark ? 'dark' : 'light'}
    onValueChange={(_event, next) => { if (!disabled) onChange(next); }} onDismiss={onDismiss} />;
}
