import type { ComponentProps, ReactNode } from 'react';
import type { ImageSourcePropType } from 'react-native';
import type { Image } from '@expo/ui/swift-ui';

type RowBase = {
  id: string;
  title: string;
  subtitle?: string;
  accessibilityHint?: string;
  testID?: string;
  disabled?: boolean;
  icon?: { ios?: ComponentProps<typeof Image>['systemName']; android?: ImageSourcePropType };
  /** Decorative React Native content, such as an avatar. Never put controls here. Overrides icon. */
  leading?: ReactNode;
};

export type GroupedListRow = RowBase & (
  | { kind?: 'value'; value?: string; onPress?: () => void; destructive?: boolean; onValueChange?: never }
  | { kind: 'toggle'; value: boolean; onValueChange: (value: boolean) => void; onPress?: never; destructive?: never }
);

export type GroupedListSection = {
  id: string;
  title?: string;
  footer?: string;
  rows: readonly GroupedListRow[];
};

/** Owns its native scroll viewport. Place in a flex container, never inside a ScrollView. */
export type GroupedListProps = { sections: readonly GroupedListSection[]; testID?: string };
