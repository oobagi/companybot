import type { ReactNode } from 'react';

export type ChoiceOption = { value: string; label: string; disabled?: boolean };
export type ChoiceMenuProps = {
  label: string;
  options: ChoiceOption[];
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
};
