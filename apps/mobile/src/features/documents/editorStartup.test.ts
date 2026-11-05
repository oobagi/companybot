import { expect, it } from 'vitest';
import { documentFontScale, editorStartup, type EditorStartup } from './editorStartup';

it('offers recovery before opening, ignores obsolete attempts, and never reloads an initialized editor or protected work', () => {
  const opening: EditorStartup = { attempt: 0, phase: 'opening' };
  const failed = editorStartup(opening, { type: 'failed', attempt: 0, error: 'Could not load' });
  expect(failed.phase).toBe('failed');
  expect(editorStartup(failed, { type: 'retry', protectedWork: true })).toBe(failed);
  const retried = editorStartup(failed, { type: 'retry', protectedWork: false });
  expect(retried).toEqual({ attempt: 1, phase: 'opening' });
  expect(editorStartup(retried, { type: 'ready', attempt: 0 })).toBe(retried);
  const ready = editorStartup(retried, { type: 'ready', attempt: 1 });
  expect(editorStartup(ready, { type: 'failed', attempt: 1, error: 'Late timeout' })).toBe(ready);
  expect(editorStartup(ready, { type: 'retry', protectedWork: false })).toBe(ready);
});

it('applies accessibility scale once when Android WebView already owns text zoom', () => {
  expect(documentFontScale('android', 1.6)).toBe(1);
  expect(documentFontScale('ios', 1.6)).toBe(1.6);
  expect(documentFontScale('web', 1.6)).toBe(1.6);
});
