// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, Node } from '@tiptap/core';
import { Step } from '@tiptap/pm/transform';
import { getVersion, sendableSteps } from 'prosemirror-collab';
import { api } from '@companybot/backend/convex/_generated/api';
import { createSyncTransport, type Submit } from './transport';
import { createEditorLifetime } from './lifetime';
import { documentSyncExtension } from './sync';

const initial = { type: 'doc', content: [{ type: 'paragraph' }] };
const documentNode = Node.create({ name: 'doc', topNode: true, content: 'paragraph+' });
const paragraph = Node.create({ name: 'paragraph', group: 'block', content: 'text*', parseHTML: () => [{ tag: 'p' }], renderHTML: () => ['p', 0] });
const text = Node.create({ name: 'text', group: 'inline' });
const editors: Editor[] = [];
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); });

/** A versioned server fixture; applies real ProseMirror steps, including conflicting clients. */
function server() {
  const accepted: { step: string; clientId: string | number }[] = [];
  let content: Editor['state']['doc'] | undefined;
  let failure: Error | undefined;
  let nextResponse: Promise<void> | undefined;
  const submit = vi.fn(async (args: Submit) => {
    if (failure) { const error = failure; failure = undefined; throw error; }
    const missing = accepted.slice(args.version - 1);
    if (missing.length) return { status: 'needs-rebase' as const, steps: missing.map(s => s.step), clientIds: missing.map(s => s.clientId) };
    expect(args.version).toBe(accepted.length + 1);
    for (const json of args.steps) {
      const result = Step.fromJSON(content!.type.schema, JSON.parse(json)).apply(content!);
      if (result.failed) throw new Error(result.failed);
      content = result.doc!;
      accepted.push({ step: json, clientId: args.clientId });
    }
    const response = nextResponse; nextResponse = undefined;
    if (response) await response;
    return { status: 'synced' as const };
  });
  return {
    submit,
    failOnce() { failure = new Error('Temporary submit failure'); },
    holdNextResponse(response: Promise<void>) { nextResponse = response; },
    get content() { return content; },
    create() {
      const transport = createSyncTransport('test-page', {
        submitSteps: submit,
        getSteps: async version => ({ steps: accepted.slice(version - 1).map(s => s.step), clientIds: accepted.slice(version - 1).map(s => s.clientId), version: accepted.length + 1 }),
      }, 1);
      const onError = vi.fn();
      const watch = vi.spyOn(transport.client, 'watchQuery');
      const editor = new Editor({
        element: document.createElement('div'), content: initial,
        extensions: [documentNode, paragraph, text, documentSyncExtension(transport.client, 'test-page', api.pageSync, { initialContent: initial, initialVersion: 1 }, { onSyncError: onError, warnOnUnsyncedClose: false })],
      });
      content ??= editor.state.doc;
      editors.push(editor);
      return { editor, transport, onError, watch };
    },
    version() { return accepted.length + 1; },
  };
}
const insert = (editor: Editor, value: string) => editor.view.dispatch(editor.state.tr.insertText(value, 1));
const ready = async (editor: Editor) => vi.waitFor(() => expect(editor.isInitialized).toBe(true));
const saved = async (editor: Editor) => vi.waitFor(() => expect(sendableSteps(editor.state)).toBeNull());

describe('mobile adapter with the real upstream collaboration extension', () => {
  it('retries rejected edits at the same server version without recreating the document', async () => {
    const backend = server();
    const { editor, transport, onError } = backend.create();
    await ready(editor);
    backend.failOnce(); insert(editor, 'unsaved');
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(sendableSteps(editor.state)).not.toBeNull();
    expect(editor.state.doc.textContent).toBe('unsaved');
    transport.retry(); // Also used on reconnect/foreground, even if latestVersion stays 1.
    await saved(editor);
    expect(backend.content!.textContent).toBe('unsaved');
    expect(backend.submit).toHaveBeenCalledTimes(2);
  });

  it('rebases two newly opened editors and converges without losing either edit', async () => {
    const backend = server();
    const first = backend.create(); const second = backend.create();
    await Promise.all([ready(first.editor), ready(second.editor)]);
    insert(first.editor, 'A'); await saved(first.editor);
    // Second editor still has the original version and must handle needs-rebase.
    insert(second.editor, 'B'); await saved(second.editor);
    first.transport.update(backend.version());
    await vi.waitFor(() => expect(getVersion(first.editor.state)).toBe(backend.version()));
    expect(first.editor.state.doc.toJSON()).toEqual(second.editor.state.doc.toJSON());
    expect(backend.content!.textContent).toContain('A');
    expect(backend.content!.textContent).toContain('B');
    expect(backend.content!.textContent).toHaveLength(2);
  });

  it('survives StrictMode detach/reattach, then flushes pending steps on final destroy', async () => {
    const backend = server();
    const { editor, onError, transport, watch } = backend.create();
    await ready(editor);
    const lifetime = createEditorLifetime(() => editor.destroy());
    const detach = lifetime.retain();
    editor.unmount(); detach();
    editor.mount(document.createElement('div'));
    const finalDetach = lifetime.retain();
    await Promise.resolve();
    expect(editor.isDestroyed).toBe(false);
    await ready(editor);
    expect(watch).toHaveBeenCalledOnce();
    backend.failOnce(); insert(editor, 'last edit');
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    // BlockNoteView unmounts the view first; Tiptap keeps its immutable state.
    editor.unmount(); finalDetach();
    await vi.waitFor(() => expect(backend.content!.textContent).toBe('last edit'));
    expect(editor.isDestroyed).toBe(true);
    const calls = backend.submit.mock.calls.length;
    transport.retry();
    await Promise.resolve();
    expect(backend.submit).toHaveBeenCalledTimes(calls);
  });

  it('does not duplicate an in-flight edit when destruction races its acknowledgement', async () => {
    const backend = server();
    const { editor, onError } = backend.create();
    await ready(editor);
    let acknowledge = () => {};
    backend.holdNextResponse(new Promise<void>(resolve => { acknowledge = resolve; }));
    insert(editor, 'once');
    await vi.waitFor(() => expect(backend.version()).toBe(2));
    expect(sendableSteps(editor.state)).not.toBeNull();
    const detach = createEditorLifetime(() => editor.destroy()).retain();
    editor.unmount(); detach();
    await vi.waitFor(() => expect(backend.submit).toHaveBeenCalledTimes(2));
    acknowledge();
    await Promise.resolve();
    expect(backend.content!.textContent).toBe('once');
    expect(backend.version()).toBe(2);
    expect(onError).not.toHaveBeenCalled();
  });
});
