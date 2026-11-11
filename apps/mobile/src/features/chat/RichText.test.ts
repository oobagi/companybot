// @vitest-environment happy-dom
import { createElement, type CSSProperties, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { RichText } from './RichText';

vi.mock('react-native', () => {
  type Style = CSSProperties | false | undefined | Style[];
  const flatten = (style: Style): CSSProperties => Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style || {};
  return {
    Text: ({ children, style, accessibilityRole }: { children: ReactNode; style: Style; accessibilityRole?: string }) => createElement('span', { style: flatten(style), role: accessibilityRole }, children),
    View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
    ScrollView: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  };
});
vi.mock('@/design', async () => {
  const { palettes, typography, spacing } = await import('@/design/tokens');
  return { useTheme: () => ({ colors: palettes.light, typography, spacing }) };
});
vi.mock('@/components/ui', async () => {
  const { Text, InlineText } = await import('@/components/ui/Text');
  const container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return { Text, InlineText, Stack: container, Card: container, Divider: () => null, ErrorState: () => null, ConfirmSheet: () => null };
});
vi.mock('@/lib/useTask', () => ({ useTask: () => ({ run: vi.fn(), busy: false }) }));
vi.mock('@/lib/api', () => ({ api: { recordTypes: { list: 'list' } } }));
vi.mock('@/lib/convex', () => ({ useQuery: () => undefined }));
vi.mock('./links', () => ({ openContentLink: vi.fn() }));

afterEach(() => { document.body.innerHTML = ''; });
const render = (value: string) => { document.body.innerHTML = renderToStaticMarkup(createElement(RichText, { value })); };
const leaf = (text: string) => [...document.querySelectorAll('span')].find(element => element.textContent === text && !element.querySelector('span'))!;

it('preserves heading size and nested emphasis instead of resetting inline runs to body text', () => {
  render('## Heading **bold _italic_** and `code`');
  const heading = document.querySelector('[role="header"]')!;
  const italic = leaf('italic');
  const code = leaf('code');
  expect(getComputedStyle(italic).fontSize).toBe(getComputedStyle(heading).fontSize);
  expect(getComputedStyle(italic).fontWeight).toBe('700');
  expect(getComputedStyle(italic).fontStyle).toBe('italic');
  expect(getComputedStyle(code).fontSize).toBe(getComputedStyle(heading).fontSize);
});

it('retains the link color through nested emphasis', () => {
  render('[**bold _link_**](https://example.com)');
  const link = document.querySelector('[role="link"]')!;
  expect(getComputedStyle(leaf('link')).color).toBe(getComputedStyle(link).color);
  expect(getComputedStyle(leaf('link')).fontWeight).toBe('700');
});
