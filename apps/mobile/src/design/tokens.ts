import type { TextStyle } from 'react-native';

/** Neutral content surfaces with the system-style blue action hierarchy. */
const light = {
  background: '#ffffff', surface: '#fafafa',
  text: '#171717', muted: '#737373', border: '#e5e5e5',
  primary: '#007aff', onPrimary: '#ffffff', pressed: '#f0f0f0',
  link: '#007aff', selected: '#e5f1ff',
  danger: '#b91c1c', dangerSurface: '#fef2f2',
  success: '#166534', successSurface: '#f0fdf4',
  warning: '#92400e', warningSurface: '#fffbeb',
  overlay: 'rgba(0,0,0,0.45)',
};
export type Colors = { [Key in keyof typeof light]: string };
const dark: Colors = {
  background: '#171717', surface: '#202020',
  text: '#fafafa', muted: '#a3a3a3', border: '#404040',
  primary: '#0a84ff', onPrimary: '#ffffff', pressed: '#333333',
  link: '#0a84ff', selected: '#102b46',
  danger: '#fca5a5', dangerSurface: '#431c1c',
  success: '#86efac', successSurface: '#143322',
  warning: '#fcd34d', warningSurface: '#3d3015',
  overlay: 'rgba(0,0,0,0.65)',
};

export const palettes = { light, dark };
export const spacing = { none: 0, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
export const radii = { sm: 6, md: 10, lg: 16, full: 999 } as const;
export const sizes = { touch: 48, icon: 22, content: 760, avatar: { sm: 32, md: 40, lg: 64 } } as const;
export const typography = {
  title: { fontSize: 28, lineHeight: 34, fontWeight: '600' },
  heading: { fontSize: 22, lineHeight: 28, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
  label: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
  // Descriptions and form guidance are readable content, not small metadata.
  supporting: { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  // Reserve captions for timestamps, badges and other brief metadata.
  caption: { fontSize: 13, lineHeight: 19, fontWeight: '400' },
} satisfies Record<string, TextStyle>;
export type TextVariant = keyof typeof typography;
