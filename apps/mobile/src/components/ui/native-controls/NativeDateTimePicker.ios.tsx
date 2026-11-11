import { DatePicker, Host } from '@expo/ui/swift-ui';
import { accessibilityValue, datePickerStyle, disabled as disabledModifier, labelsHidden } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '@/design';
import type { NativeDateTimePickerProps } from './NativeDateTimePicker.types';

/** Keep the native compact control while giving VoiceOver its field name. */
export function NativeDateTimePicker({ label, mode, value, disabled, onChange }: NativeDateTimePickerProps) {
  const { colors, dark } = useTheme();
  const spokenValue = mode === 'date'
    ? value.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : value.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return <Host matchContents colorScheme={dark ? 'dark' : 'light'} seedColor={colors.link} ignoreSafeArea="all">
    <DatePicker title={label} selection={value} displayedComponents={mode === 'date' ? ['date'] : ['hourAndMinute']}
      modifiers={[datePickerStyle('compact'), labelsHidden(), disabledModifier(disabled), accessibilityValue(spokenValue)]}
      onDateChange={next => { if (!disabled) onChange(next); }} />
  </Host>;
}
