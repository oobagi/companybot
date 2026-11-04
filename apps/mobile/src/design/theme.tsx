import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { ThemeProvider as NavigationThemeProvider, DefaultTheme, DarkTheme } from 'expo-router';
import { palettes, radii, sizes, spacing, typography, type Colors } from './tokens';

export type Theme = { colors: Colors; dark: boolean; spacing: typeof spacing; radii: typeof radii; sizes: typeof sizes; typography: typeof typography };
const themes: Record<'light' | 'dark', Theme> = {
  light: { colors: palettes.light, dark: false, spacing, radii, sizes, typography },
  dark: { colors: palettes.dark, dark: true, spacing, radii, sizes, typography },
};
const ThemeContext = createContext<Theme | null>(null);

/** Optional explicit appearance supports account preferences; system is the default. */
export function ThemeProvider({ children, appearance = 'system' }: { children: ReactNode; appearance?: 'system' | 'light' | 'dark' }) {
  const system = useColorScheme();
  const mode = appearance === 'system' ? (system ?? 'light') : appearance;
  const theme = useMemo(() => themes[mode], [mode]);
  const navigationTheme = useMemo(() => ({
    ...(theme.dark ? DarkTheme : DefaultTheme),
    colors: {
      ...(theme.dark ? DarkTheme.colors : DefaultTheme.colors),
      primary: theme.colors.link,
      background: theme.colors.background,
      card: theme.colors.background,
      text: theme.colors.text,
      border: theme.colors.border,
      notification: theme.colors.danger,
    },
  }), [theme]);
  return <ThemeContext.Provider value={theme}><NavigationThemeProvider value={navigationTheme}>{children}</NavigationThemeProvider></ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('Mobile UI must be rendered inside ThemeProvider.');
  return theme;
}
