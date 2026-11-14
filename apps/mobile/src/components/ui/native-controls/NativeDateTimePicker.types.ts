export type NativeDateTimePickerProps = {
  label: string;
  mode: 'date' | 'time';
  value: Date;
  disabled: boolean;
  onChange: (value: Date) => void;
  onDismiss: () => void;
};
