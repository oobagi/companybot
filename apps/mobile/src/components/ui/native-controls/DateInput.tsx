import { Field } from '../Field';
import type { DateInputProps } from './DateInput.types';

export function DateInput({ label, value, onChange, disabled }: DateInputProps) {
  return <Field label={label} value={value} onChangeText={onChange} editable={!disabled} autoCorrect={false} autoCapitalize="none" hint="YYYY-MM-DD" />;
}
