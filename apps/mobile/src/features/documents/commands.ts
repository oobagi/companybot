import type { BlockAction } from './blockActions';
import type { FormatCommand } from './formatting';

export type DocumentCommand = { kind: 'blocks' | 'page' | 'link' | FormatCommand | `action:${Exclude<BlockAction, 'page'>}`; request: number };

/** Prop delivery may repeat during sync or reconnect. Consume each native request once. */
export function createDocumentCommandReceiver(initialRequest = 0) {
  let previous = initialRequest;
  return (command: DocumentCommand | undefined, editable: boolean, run: (kind: DocumentCommand['kind']) => void) => {
    if (!command || command.request <= previous) return;
    previous = command.request;
    // Discard commands received after permission loss instead of replaying them later.
    if (editable) run(command.kind);
  };
}
