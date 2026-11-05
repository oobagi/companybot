// @vitest-environment happy-dom
import { BlockNoteEditor } from '@blocknote/core';
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { palettes } from '@/design/tokens';
import DocumentDOM from './Editor.dom';
import { documentSchema } from './schema';
import { encodeDocumentPayload } from './domPayload';

// Exercise the real BlockNote/Mantine mount: headless schema tests cannot catch
// an editor disappearing when React detaches and reattaches its DOM view.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove(); root = undefined; host = undefined;
  vi.unstubAllEnvs();
});

it('keeps saved text and child references available across remounts, appearance changes and permission changes', async () => {
  vi.stubEnv('EXPO_DOM_HOST_OS', 'ios');
  const source = BlockNoteEditor.create({ schema: documentSchema, initialContent: [
    { type: 'paragraph', content: 'Saved document text' },
    { type: 'page', props: { pageId: 'child-page' } },
  ] });
  const content = JSON.stringify(source._tiptapEditor.state.doc.toJSON());
  source._tiptapEditor.destroy();
  const render = (editable: boolean, fontScale = 1, dark = false) => createElement(StrictMode, null, createElement(DocumentDOM, {
    payload: encodeDocumentPayload({ pageId: 'saved-page', snapshot: { content, version: 1 }, latestVersion: 1, editable, canCreatePage: true, dark, fontScale, colors: dark ? palettes.dark : palettes.light, references: { 'child-page': { title: 'Saved child', archived: false } } }),
    getSteps: async () => ({ steps: [], clientIds: [], version: 1 }),
    submitSteps: async () => { throw new Error('Unexpected write'); },
    onBlockActions: async () => null, onCreatePage: async () => null,
    onReferences: async () => {}, onOpenLink: async () => {}, onRemovePages: async () => false,
    onStatus: async () => {}, onImageResult: async () => {},
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(render(true)));
  expect(host.querySelector('[contenteditable]')?.textContent).toContain('Saved document text');
  expect(host.textContent).toContain('Saved child');
  const mountedEditor = host.querySelector('[contenteditable]');
  await act(async () => root!.render(render(true, 2, true)));
  expect(host.querySelector('[contenteditable]')).toBe(mountedEditor);
  expect(host.querySelector('[contenteditable]')?.textContent).toContain('Saved document text');
  await act(async () => root!.render(render(false)));
  expect(host.querySelector('[contenteditable]')?.getAttribute('contenteditable')).toBe('false');
  expect(host.querySelector('[contenteditable]')?.textContent).toContain('Saved document text');
  await act(async () => root!.render(render(true)));
  expect(host.querySelector('[contenteditable]')?.getAttribute('contenteditable')).toBe('true');
  expect(host.querySelector('[contenteditable]')?.textContent).toContain('Saved document text');
});

it('reports an unreadable snapshot without mounting an editable document', async () => {
  const status = vi.fn(async () => {});
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(DocumentDOM, {
    payload: encodeDocumentPayload({ pageId: 'invalid-page', snapshot: { content: '{broken', version: 1 }, latestVersion: 1, editable: true, canCreatePage: false, dark: false, colors: palettes.light, references: {} }),
    getSteps: async () => ({ steps: [], clientIds: [], version: 1 }), submitSteps: async () => { throw new Error('Unexpected write'); },
    onBlockActions: async () => null, onCreatePage: async () => null, onReferences: async () => {}, onOpenLink: async () => {}, onRemovePages: async () => false,
    onStatus: status, onImageResult: async () => {},
  })));
  expect(status).toHaveBeenCalledWith(false, expect.any(String));
  expect(host.querySelector('[contenteditable]')).toBeNull();
  expect(report).toHaveBeenCalled();
  report.mockRestore();
});
