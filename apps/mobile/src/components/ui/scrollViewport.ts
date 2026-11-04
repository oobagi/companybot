import { createContext, useCallback, useState } from 'react';
import type { LayoutChangeEvent, ViewStyle } from 'react-native';

/** Set only by navigation stacks whose native chrome overlays the route frame. */
export const OverlayChromeContext = createContext(false);
export type ScrollInsets = { top: number; bottom: number };
export const ScrollInsetsContext = createContext<ScrollInsets>({ top: 0, bottom: 0 });

/** UIKit adds adjusted insets after Yoga layout. Root flexGrow would fill the
 * uninset viewport, introducing an extra scroll range even with empty content. */
export function useScrollViewport({ top, bottom }: ScrollInsets, onLayout?: (event: LayoutChangeEvent) => void) {
  const [height, setHeight] = useState<number>();
  const measure = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    setHeight(previous => previous !== undefined && Math.abs(previous - next) < 0.5 ? previous : next);
    onLayout?.(event);
  }, [onLayout]);
  const contentStyle: ViewStyle = { flexGrow: 0, minHeight: height === undefined ? undefined : Math.max(0, height - top - bottom) };
  return { onLayout: measure, contentStyle };
}
