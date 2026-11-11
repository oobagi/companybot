// @vitest-environment happy-dom
import { BlockNoteEditor } from '@blocknote/core';
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { palettes } from '@/design/tokens';
import DocumentDOM from './Editor.dom';
import { documentSchema, type PageEditor } from './schema';
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['ios', 'android'])('tracks and releases the %s visual viewport without the web formatting toolbar', async platform => {
  vi.stubEnv('EXPO_DOM_HOST_OS', platform);
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 740, offsetTop: 0, offsetLeft: 0, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(390);
  const source = BlockNoteEditor.create({ schema: documentSchema, initialContent: [{ type: 'paragraph', content: 'Viewport test' }] });
  const content = JSON.stringify(source._tiptapEditor.state.doc.toJSON());
  source._tiptapEditor.destroy();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(DocumentDOM, {
    payload: encodeDocumentPayload({ pageId: 'viewport-page', snapshot: { content, version: 1 }, latestVersion: 1, editable: true, canCreatePage: false, dark: false, colors: palettes.light, references: {} }),
    getSteps: async () => ({ steps: [], clientIds: [], version: 1 }), submitSteps: async () => { throw new Error('Unexpected write'); },
    onBlockActions: async () => null, onCreatePage: async () => null, onReferences: async () => {}, onOpenLink: async () => {}, onRemovePages: async () => false,
    onStatus: async () => {}, onImageResult: async () => {},
  })));
  const style = document.documentElement.style;
  expect(style.getPropertyValue('--bn-vv-height')).toBe('740px');
  expect(style.getPropertyValue('--bn-vv-width')).toBe('390px');
  await act(async () => { viewport.height = 430; viewport.dispatchEvent(new Event('resize')); });
  expect(style.getPropertyValue('--bn-vv-height')).toBe('430px');
  await act(async () => { viewport.offsetTop = 24; viewport.offsetLeft = 6; viewport.dispatchEvent(new Event('scroll')); });
  expect(style.getPropertyValue('--bn-vv-top')).toBe('24px');
  expect(style.getPropertyValue('--bn-vv-left')).toBe('6px');
  expect(document.querySelector('.bn-mobile-formatting-toolbar')).toBeNull();
  expect(document.querySelector('.bn-formatting-toolbar')).toBeNull();
  await act(async () => root!.unmount()); root = undefined;
  await act(async () => { viewport.height = 700; viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll')); });
  for (const property of ['top', 'left', 'width', 'height', 'scale']) expect(style.getPropertyValue(`--bn-vv-${property}`)).toBe('');
});

it('reveals a focused caret after viewport shrink without changing content or following manual scrolling', async () => {
  vi.stubEnv('EXPO_DOM_HOST_OS', 'ios');
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 740, offsetTop: 0, offsetLeft: 0, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  const source = BlockNoteEditor.create({ schema: documentSchema, initialContent: [{ type: 'paragraph', content: 'Keep this caret visible' }] });
  const content = JSON.stringify(source._tiptapEditor.state.doc.toJSON());
  source._tiptapEditor.destroy();
  const create = vi.spyOn(BlockNoteEditor, 'create');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(DocumentDOM, {
    payload: encodeDocumentPayload({ pageId: 'caret-page', snapshot: { content, version: 1 }, latestVersion: 1, editable: true, canCreatePage: false, dark: false, colors: palettes.light, references: {} }),
    getSteps: async () => ({ steps: [], clientIds: [], version: 1 }), submitSteps: async () => { throw new Error('Unexpected write'); },
    onBlockActions: async () => null, onCreatePage: async () => null, onReferences: async () => {}, onOpenLink: async () => {}, onRemovePages: async () => false,
    onStatus: async () => {}, onImageResult: async () => {},
  })));
  const editor = create.mock.results.at(-1)!.value as PageEditor;
  const pm = editor._tiptapEditor;
  // Happy DOM has no layout engine; retain the real scroll-only transaction but
  // let native QA establish the actual caret geometry and focus behavior.
  pm.view.setProps({ handleScrollToSelection: () => true });
  const focused = vi.spyOn(pm.view, 'hasFocus').mockReturnValue(true);
  const scrolls: boolean[] = [];
  pm.on('transaction', ({ transaction }) => { if (transaction.scrolledIntoView) scrolls.push(transaction.docChanged); });
  const selection = pm.state.selection.toJSON();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const flush = async () => act(async () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(0); } });
  const resize = async (height: number) => act(async () => { viewport.height = height; viewport.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('resize')); });
  viewport.scale = 2;
  await resize(370); await flush();
  expect(scrolls).toEqual([]);
  viewport.scale = 1;
  await resize(740); await flush();
  await resize(430);
  expect(scrolls).toEqual([]);
  expect(document.documentElement.style.getPropertyValue('--bn-vv-height')).toBe('430px');
  await flush();
  expect(scrolls).toEqual([false]);
  expect(pm.state.selection.toJSON()).toEqual(selection);
  expect(JSON.stringify(pm.state.doc.toJSON())).toBe(content);
  await act(async () => { viewport.offsetTop = 20; viewport.dispatchEvent(new Event('scroll')); host!.querySelector('.bn-scroll-container')!.dispatchEvent(new Event('scroll')); });
  await flush();
  await resize(740); await flush();
  focused.mockReturnValue(false);
  await resize(430); await flush();
  focused.mockReturnValue(true);
  await act(async () => { editor.isEditable = false; });
  await resize(400); await flush();
  expect(scrolls).toEqual([false]);
  await act(async () => { editor.isEditable = true; });
  await resize(380);
  focused.mockReturnValue(false); await flush();
  expect(scrolls).toEqual([false]);
  focused.mockReturnValue(true);
  await resize(360);
  await resize(740); await flush();
  expect(scrolls).toEqual([false]);
  await resize(360);
  await act(async () => root!.unmount()); root = undefined;
  expect(frames.size).toBe(0);
  await resize(340); await flush();
  expect(scrolls).toEqual([false]);
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


it.each([false, true])('opens desktop record references from a document (editable: %s) without changing its content', async (editable) => {
  const href = 'companybot://record/record1';
  const source = BlockNoteEditor.create({ schema: documentSchema, links: { isValidLink: () => true }, initialContent: [
    { type: 'paragraph', content: [{ type: 'link', href, content: [{ type: 'text', text: 'Customer record', styles: {} }] }] },
  ] });
  const content = JSON.stringify(source._tiptapEditor.state.doc.toJSON());
  source._tiptapEditor.destroy();
  const open = vi.fn(async () => {});
  const submit = vi.fn(async () => { throw new Error('Unexpected write'); });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(DocumentDOM, {
    payload: encodeDocumentPayload({ pageId: 'saved-page', snapshot: { content, version: 1 }, latestVersion: 1, editable, canCreatePage: false, dark: false, colors: palettes.light, references: {} }),
    getSteps: async () => ({ steps: [], clientIds: [], version: 1 }), submitSteps: submit,
    onBlockActions: async () => null, onCreatePage: async () => null, onReferences: async () => {}, onOpenLink: open,
    onRemovePages: async () => false, onStatus: async () => {}, onImageResult: async () => {},
  })));
  const link = host.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!;
  expect(link).not.toBeNull();
  await act(async () => link.click());
  expect(open).toHaveBeenCalledExactlyOnceWith(href);
  expect(host.querySelector('[contenteditable]')?.textContent).toContain('Customer record');
  expect(submit).not.toHaveBeenCalled();
});

it('reports native selection state and runs only formatting commands delivered after mount', async () => {
  vi.stubEnv('EXPO_DOM_HOST_OS', 'ios');
  const source = BlockNoteEditor.create({ schema: documentSchema, initialContent: [{ type: 'paragraph', content: 'Native formatting target' }] });
  const content = JSON.stringify(source._tiptapEditor.state.doc.toJSON());
  source._tiptapEditor.destroy();
  const formatting = vi.fn(async () => {});
  const render = (request: number, editable = true) => createElement(DocumentDOM, {
    payload: encodeDocumentPayload({ pageId: 'format-page', snapshot: { content, version: 1 }, latestVersion: 1, editable, canCreatePage: false, dark: false, colors: palettes.light, references: {}, command: { request, kind: 'text:heading2' } }),
    getSteps: async () => ({ steps: [], clientIds: [], version: 1 }), submitSteps: async () => ({ status: 'synced' as const }),
    onBlockActions: async () => null, onCreatePage: async () => null, onReferences: async () => {}, onOpenLink: async () => {}, onRemovePages: async () => false,
    onStatus: async () => {}, onImageResult: async () => {}, onFormatting: formatting,
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(render(1)));
  expect(host.querySelector('h2')).toBeNull();
  expect(formatting).toHaveBeenCalledWith(expect.objectContaining({ text: 'paragraph', canFormat: true }));
  await act(async () => root!.render(render(2)));
  expect(host.querySelector('h2')?.textContent).toBe('Native formatting target');
  expect(formatting).toHaveBeenCalledWith(expect.objectContaining({ text: 'heading2' }));
  expect(document.querySelector('.bn-mobile-formatting-toolbar')).toBeNull();
});

it.each([
  ['example.com', 'https://example.com/'],
  ['ftp://example.com', null],
] as const)('handles a stored %s link without rewriting the document', async (href, destination) => {
  const source = BlockNoteEditor.create({ schema: documentSchema, initialContent: [{ type: 'paragraph', content: [{ type: 'link', href, content: 'Saved link' }] }] });
  const content = JSON.stringify(source._tiptapEditor.state.doc.toJSON());
  source._tiptapEditor.destroy();
  const open = vi.fn(async () => {});
  const submit = vi.fn(async () => { throw new Error('Unexpected write'); });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(DocumentDOM, {
    payload: encodeDocumentPayload({ pageId: 'legacy-links', snapshot: { content, version: 1 }, latestVersion: 1, editable: false, canCreatePage: false, dark: false, colors: palettes.light, references: {} }),
    getSteps: async () => ({ steps: [], clientIds: [], version: 1 }), submitSteps: submit,
    onBlockActions: async () => null, onCreatePage: async () => null, onReferences: async () => {}, onOpenLink: open,
    onRemovePages: async () => false, onStatus: async () => {}, onImageResult: async () => {},
  })));
  const link = host.querySelector<HTMLAnchorElement>('a[href]')!;
  expect(link.getAttribute('href')).toBe(href);
  await act(async () => link.click());
  if (destination) expect(open).toHaveBeenCalledExactlyOnceWith(destination);
  else {
    expect(open).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('not supported');
  }
  expect(link.getAttribute('href')).toBe(href);
  expect(submit).not.toHaveBeenCalled();
});
