import { createContext, useCallback, useContext, useLayoutEffect, useId, useState, type ReactNode } from 'react';
import { useConfirm } from '@/components/ui/useConfirm';
import { createUnsavedWorkState } from './unsavedWorkState';

const Context = createContext<{ mark: (key: string, dirty: boolean, busy?: boolean) => void; confirmDiscard: () => Promise<boolean> } | null>(null);
export function UnsavedWorkProvider({ children }: { children: ReactNode }) {
  const [pending] = useState(createUnsavedWorkState);
  const { confirm, dialog } = useConfirm();
  const mark = pending.mark;
  const confirmDiscard = useCallback(() => pending.confirmDiscard(
    () => confirm({ title: 'Unsaved changes', body: 'Unsaved form edits will be discarded. Any document recovery copies already saved on this device will remain available.', action: 'Discard changes', danger: true }),
    () => confirm({ title: 'Please wait', body: 'An operation is still in progress. Let it finish before switching workspaces.', action: 'OK' }),
  ), [confirm, pending]);
  return <Context.Provider value={{ mark, confirmDiscard }}>{children}{dialog}</Context.Provider>;
}
export function useUnsavedWork() {
  const context = useContext(Context);
  if (!context) throw new Error('UnsavedWorkProvider is missing.');
  return context;
}
/** Tasks can also run in isolated component previews without a workspace provider. */
export const useOptionalUnsavedWork = () => useContext(Context);
export function useUnsavedDocument(key: string, dirty: boolean, busy = false) {
  const { mark } = useUnsavedWork();
  const instance = useId();
  const identity = `${key}:${instance}`;
  useLayoutEffect(() => { mark(identity, dirty, busy); return () => mark(identity, false); }, [mark, identity, dirty, busy]);
}
