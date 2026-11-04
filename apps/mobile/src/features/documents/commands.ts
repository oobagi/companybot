export type DocumentCommand = { kind: 'blocks' | 'page'; request: number };

/** Prop delivery may repeat during sync or reconnect. Consume each native request once. */
export function createDocumentCommandReceiver() {
  let previous = 0;
  return (command: DocumentCommand | undefined, editable: boolean, run: (kind: DocumentCommand['kind']) => void) => {
    if (!command || command.request <= previous) return;
    previous = command.request;
    // Discard commands received after permission loss instead of replaying them later.
    if (editable) run(command.kind);
  };
}
