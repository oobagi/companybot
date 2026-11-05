import { describe, expect, it } from 'vitest';
import { palettes } from '@/design/tokens';
import { decodeDocumentPayload, encodeDocumentPayload, type DocumentPayload } from './domPayload';

// RN WebView 14's iOS and Android injectedObjectJson implementations return
// the serialized props from a template literal, before Expo JSON.parse's them.
const nativeInitialProps = (props: object) => JSON.parse(new Function(`return \`${JSON.stringify(props)}\`;`)());

const payload = (text: string): DocumentPayload => ({
  pageId: 'page-a',
  snapshot: { content: JSON.stringify({ type: 'doc', content: [{ type: 'text', text }] }), version: 1 },
  latestVersion: 1,
  editable: true,
  canCreatePage: true,
  dark: false,
  colors: palettes.light,
  references: { 'page-b': { title: text, archived: false } },
  image: { url: `https://example.test/${text}`, request: 1 },
});

describe('document initial props through the native WebView', () => {
  it.each(['"quoted"', '`code`', '${1 + 1}', 'path\\file / slash', 'first\nsecond\tcolumn', '你好 👋 café', '\ud800'])('preserves document content and references: %j', text => {
    const value = payload(text);
    const initial = { EXPO_DOM_HOST_OS: 'android', initialProps: { names: ['submitSteps'], props: { payload: encodeDocumentPayload(value) } } };
    const received = nativeInitialProps(initial);
    expect(received.EXPO_DOM_HOST_OS).toBe('android');
    expect(decodeDocumentPayload(received.initialProps.props.payload)).toEqual(value);
    expect(received.initialProps.names).toEqual(['submitSteps']);
  });

  it('does not expose nested snapshot JSON directly to native template evaluation', () => {
    const value = payload('Plain text');
    // Without the boundary encoding, even an empty document's JSON escapes are consumed.
    expect(() => nativeInitialProps({ props: value })).toThrow();
    expect(decodeDocumentPayload(nativeInitialProps({ payload: encodeDocumentPayload(value) }).payload)).toEqual(value);
  });
});
