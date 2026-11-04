import type { Editor } from '@tiptap/core';
import { syncExtension } from '@convex-dev/prosemirror-sync/tiptap';

/** BlockNote remounts its Tiptap view during StrictMode and editable changes. */
export function documentSyncExtension(...args: Parameters<typeof syncExtension>) {
  const initialized = new WeakSet<Editor>();
  return syncExtension(...args).extend({
    onCreate(event) {
      // Tiptap emits create on each view mount. The upstream extension owns one
      // subscription and beforeunload handler per editor, not per view.
      if (initialized.has(this.editor)) return;
      initialized.add(this.editor);
      this.parent?.(event);
    },
    onDestroy() {
      initialized.delete(this.editor);
      this.parent?.();
    },
  });
}
