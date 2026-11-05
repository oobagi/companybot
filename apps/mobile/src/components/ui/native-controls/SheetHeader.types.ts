export type SheetHeaderProps = {
  title: string;
  onClose: () => void;
  busy?: boolean;
  /** Supplying a submit action makes this a Cancel / Done editor. */
  submit?: { onPress: () => void; disabled?: boolean };
};
