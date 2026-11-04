import type { BlockAction, BlockTarget } from './blockActions';

export type ActionRequest = { kind: 'block'; target: BlockTarget } | { kind: 'create' };
export type ActionReply = BlockAction | { pageId: string } | null;
export type PendingAction = { request: ActionRequest; finish: (reply: ActionReply) => void };

/** A native presentation owns exactly one DOM request; unmount always releases its promise. */
export function createActionRequests(show: (pending: PendingAction | undefined) => void) {
  let pending: PendingAction | undefined;
  return {
    request(request: ActionRequest): Promise<ActionReply> {
      if (pending) return Promise.resolve(null);
      return new Promise(resolve => {
        const current: PendingAction = { request, finish(reply) { if (pending !== current) return; pending = undefined; show(undefined); resolve(reply); } };
        pending = current; show(current);
      });
    },
    cancel() { pending?.finish(null); },
  };
}
