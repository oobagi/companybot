import { expectTypeOf, it } from 'vitest';
import type { ButtonProps } from './Button';
import type { ScreenListProps } from './Layout';

it('only advertises button interactions and accessibility states supported on every platform', () => {
  expectTypeOf<Extract<keyof ButtonProps, 'onLongPress' | 'onPressIn' | 'onPressOut' | 'onHoverIn' | 'onHoverOut'>>().toEqualTypeOf<never>();
  expectTypeOf<ButtonProps['onPress']>().toEqualTypeOf<(() => void) | undefined>();
  expectTypeOf<keyof NonNullable<ButtonProps['accessibilityState']>>().toEqualTypeOf<'busy' | 'selected'>();
  const button = { label: 'Save', onPress: () => {}, disabled: false, loading: true, testID: 'save', accessibilityLabel: 'Save changes', accessibilityHint: 'Saves this draft', accessibilityState: { busy: true } };
  expectTypeOf(button).toExtend<ButtonProps>();
});

it('keeps list inset ownership internal while preserving virtualized list callbacks', () => {
  type Props = ScreenListProps<{ id: string }>;
  expectTypeOf<Extract<keyof Props, 'contentInset' | 'contentInsetAdjustmentBehavior' | 'automaticallyAdjustContentInsets' | 'automaticallyAdjustsScrollIndicatorInsets' | 'scrollIndicatorInsets'>>().toEqualTypeOf<never>();
  expectTypeOf<Props>().toHaveProperty('onEndReached');
  expectTypeOf<Props>().toHaveProperty('onLayout');
  expectTypeOf<Props>().toHaveProperty('ListEmptyComponent');
});
