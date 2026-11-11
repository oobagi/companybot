export type TimeInputProps = {
  label: string;
  /** Wall-clock time, independent of a calendar date or time zone: HH:mm. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};
