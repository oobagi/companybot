import type { ComponentProps } from 'react';
import type { Icon } from '@expo/ui/jetpack-compose';
import type { Image } from '@expo/ui/swift-ui';

export type ContentToolbarAction = {
  id: string;
  label: string;
  icon: {
    ios: NonNullable<ComponentProps<typeof Image>['systemName']>;
    android: ComponentProps<typeof Icon>['source'];
  };
  onPress: () => void;
  disabled?: boolean;
};

/** A small set of editing actions. The containing screen owns keyboard and safe-area placement. */
export type ContentToolbarProps = {
  actions: readonly ContentToolbarAction[];
  status?: string;
  busy?: boolean;
  accessibilityLabel?: string;
};
