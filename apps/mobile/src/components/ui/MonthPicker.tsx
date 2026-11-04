import { Host, Column, Row, Picker, Spacer, Text as NativeText } from '@expo/ui';
import { useTheme } from '@/design';

/** Calendar months, not timestamps: selecting a period must not shift with the device's zone. */
export function MonthPicker({ value, onChange }: { value: string; onChange: (month: string) => void }) {
  const { colors, spacing, dark } = useTheme();
  const [year, month] = value.split('-').map(Number);
  const months = Array.from({ length: 12 }, (_, index) => ({
    value: index + 1,
    label: new Date(2000, index, 1).toLocaleDateString(undefined, { month: 'long' }),
  }));
  const lastYear = Math.max(new Date().getFullYear(), year);
  const years = Array.from({ length: lastYear - 1970 + 1 }, (_, index) => lastYear - index);
  const select = (nextYear: number, nextMonth: number) => onChange(`${nextYear}-${String(nextMonth).padStart(2, '0')}`);
  return <Host matchContents={{ vertical: true }} style={{ width: '100%' }} colorScheme={dark ? 'dark' : 'light'} seedColor={colors.link} ignoreSafeArea="all">
    <Column spacing={spacing.md}>
      <Row alignment="center" spacing={spacing.md}>
        <NativeText textStyle={{ color: colors.text }}>Month</NativeText><Spacer flexible />
        <Picker selectedValue={month} onValueChange={next => select(year, next)} testID="usage-month">
          {months.map(item => <Picker.Item key={item.value} value={item.value} label={item.label} />)}
        </Picker>
      </Row>
      <Row alignment="center" spacing={spacing.md}>
        <NativeText textStyle={{ color: colors.text }}>Year</NativeText><Spacer flexible />
        <Picker selectedValue={year} onValueChange={next => select(next, month)} testID="usage-year">
          {years.map(item => <Picker.Item key={item} value={item} label={String(item)} />)}
        </Picker>
      </Row>
    </Column>
  </Host>;
}
