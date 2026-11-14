import { Field } from '../Field';
import type { TimeInputProps } from './TimeInput.types';

/** Web fallback keeps the same wall-clock value contract as the native picker. */
export function TimeInput({ label, value, onChange, disabled }: TimeInputProps) {
  return <Field label={label} value={value} onChangeText={onChange} editable={!disabled} autoCorrect={false} autoCapitalize="none" maxLength={5} hint="24-hour time (HH:mm)" />;
}
