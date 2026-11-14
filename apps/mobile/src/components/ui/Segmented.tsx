import { SegmentedControl } from '@expo/ui/community/segmented-control';
import { useWindowDimensions } from 'react-native';
import { useTheme } from '@/design';
import { ChoicePicker } from './EditorSheet';

/** System segmented choices, with a readable menu at accessibility text sizes. */
export function Segmented({ label, options, value, onChange }: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { dark, sizes } = useTheme();
  const { fontScale } = useWindowDimensions();
  if (fontScale > 1.3) return <ChoicePicker label={label} options={options} value={value} onChange={next => { if (typeof next === 'string') onChange(next); }} />;
  return <SegmentedControl accessibilityLabel={label} values={options.map(option => option.label)} selectedIndex={options.findIndex(option => option.value === value)} appearance={dark ? 'dark' : 'light'} style={{ minHeight: sizes.touch }} onChange={event => {
    const option = options[event.nativeEvent.selectedSegmentIndex];
    if (option) onChange(option.value);
  }} />;
}
