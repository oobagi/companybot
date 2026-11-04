import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import { useTheme } from '@/design';
import { OverlayChromeContext } from '@/components/ui/scrollViewport';

/** Each native tab owns a navigation controller and its system header. */
export function TabStack({ title }: { title: string }) {
  const { colors, dark } = useTheme();
  return <OverlayChromeContext.Provider value={Platform.OS === 'ios'}><Stack screenOptions={{
    title,
    statusBarStyle: dark ? 'light' : 'dark',
    headerLargeTitleEnabled: Platform.OS === 'ios',
    headerTransparent: Platform.OS === 'ios',
    // iOS 26 supplies the native content fade. Older iOS needs a translucent
    // material once content scrolls beneath the compact navigation bar.
    headerBlurEffect: Platform.OS === 'ios' && Number(Platform.Version) < 26 ? 'systemChromeMaterial' : undefined,
    scrollEdgeEffects: { top: 'automatic' },
    headerTintColor: colors.link,
    headerTitleStyle: { color: colors.text },
    headerLargeTitleStyle: { color: colors.text },
    headerShadowVisible: false,
    contentStyle: { backgroundColor: colors.background },
  }} /></OverlayChromeContext.Provider>;
}
