import type { ConvexReactClient } from 'convex/react';
import { getFunctionName, type FunctionReference, type FunctionReturnType } from 'convex/server';
import { api } from '@companybot/backend/convex/_generated/api';

export type Snapshot = FunctionReturnType<typeof api.pageSync.getSnapshot>;
export type Steps = FunctionReturnType<typeof api.pageSync.getSteps>;
export type SubmitResult = FunctionReturnType<typeof api.pageSync.submitSteps>;
export type Submit = { version: number; clientId: string | number; steps: string[] };
export type EditorTransport = {
  getSteps: (version: number) => Promise<Steps>;
  submitSteps: (args: Submit) => Promise<SubmitResult>;
};

/** A capability-limited adapter for the upstream sync extension. No credentials enter the DOM. */
export function createSyncTransport(id: string, callbacks: EditorTransport, initialVersion: number | null) {
  let version = initialVersion;
  const listeners = new Set<() => void>();
  const assertPage = (args: { id: string }) => { if (args.id !== id) throw new Error('This editor cannot access another document.'); };
  const client = {
    query: async (ref: FunctionReference<'query'>, args: { id: string; version: number }) => {
      assertPage(args);
      if (getFunctionName(ref) !== getFunctionName(api.pageSync.getSteps)) throw new Error('Unsupported editor query.');
      return callbacks.getSteps(args.version);
    },
    mutation: async (ref: FunctionReference<'mutation'>, args: Submit & { id: string }) => {
      assertPage(args);
      const name = getFunctionName(ref);
      // The backend already atomically saves canonical snapshots with accepted steps.
      if (name === getFunctionName(api.pageSync.submitSnapshot)) return null;
      if (name !== getFunctionName(api.pageSync.submitSteps)) throw new Error('Unsupported editor mutation.');
      return callbacks.submitSteps({ version: args.version, clientId: args.clientId, steps: args.steps });
    },
    watchQuery: (ref: FunctionReference<'query'>, args: { id: string }) => {
      assertPage(args);
      if (getFunctionName(ref) !== getFunctionName(api.pageSync.latestVersion)) throw new Error('Unsupported editor subscription.');
      return { localQueryResult: () => version, onUpdate: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
    },
  };
  return {
    // The upstream extension accepts the whole client, but consumes only the three methods above.
    client: client as unknown as ConvexReactClient,
    replaceCallbacks(next: EditorTransport) { callbacks = next; },
    update(next: number | null) { version = next; for (const listener of listeners) listener(); },
    // A failed submit or reconnect need not change the server version.
    retry() { for (const listener of listeners) listener(); },
  };
}
