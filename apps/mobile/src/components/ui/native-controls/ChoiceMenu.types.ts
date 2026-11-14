import type { ReactNode } from 'react';

export type ChoiceOption = { value: string; label: string; disabled?: boolean };
export type ChoiceMenuProps = {
  /** Field name; native controls add the selected value for accessibility. */
  label: string;
  selectionLabel: string;
  options: ChoiceOption[];
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  presentation?: 'row' | 'compact';
};
