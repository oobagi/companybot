import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ComponentRef } from 'react';
import { Platform, type LayoutChangeEvent, type View, type ViewStyle } from 'react-native';
import { HeaderHeightContext } from 'expo-router/react-navigation';

/** Set only by navigation stacks whose native chrome overlays the route frame. */
export const OverlayChromeContext = createContext(false);
export type ScrollInsets = { top: number; bottom: number };
export const ScrollInsetsContext = createContext<ScrollInsets>({ top: 0, bottom: 0 });

/** UIKit adds adjusted insets after Yoga layout. Root flexGrow would fill the
 * uninset viewport, introducing an extra scroll range even with empty content. */
export function useScrollViewport({ top, bottom }: ScrollInsets, onLayout?: (event: LayoutChangeEvent) => void) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const [height, setHeight] = useState<number>();
  const [windowTop, setWindowTop] = useState<number>();
  const measure = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    setHeight(previous => previous !== undefined && Math.abs(previous - next) < 0.5 ? previous : next);
    onLayout?.(event);
  }, [onLayout]);
  useLayoutEffect(() => {
    if (Platform.OS !== 'ios' || height === undefined) return;
    let active = true;
    // Native search can extend a route beneath its header even when the stack
    // isn't marked transparent. Measure its real frame instead of assuming it.
    ref.current?.measureInWindow((_x, y) => {
      if (active) setWindowTop(previous => previous !== undefined && Math.abs(previous - y) < 0.5 ? previous : y);
    });
    return () => { active = false; };
  }, [headerHeight, height]);
  const coveredTop = Platform.OS === 'ios' && windowTop !== undefined ? Math.max(0, headerHeight - windowTop) : top;
  const contentStyle: ViewStyle = { flexGrow: 0, minHeight: height === undefined ? undefined : Math.max(0, height - coveredTop - bottom) };
  return { ref, onLayout: measure, contentStyle };
}
