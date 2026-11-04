import { createContext, useCallback, useContext, useEffect, useId, useRef, type ReactNode } from 'react';
import { useConfirm } from '@/components/ui/useConfirm';

const Context = createContext<{ mark: (key: string, dirty: boolean) => void; confirmDiscard: () => Promise<boolean> } | null>(null);
export function UnsavedWorkProvider({ children }: { children: ReactNode }) {
  const pending = useRef(new Set<string>());
  const { confirm, dialog } = useConfirm();
  const mark = useCallback((key: string, dirty: boolean) => { if (dirty) pending.current.add(key); else pending.current.delete(key); }, []);
  const confirmDiscard = useCallback(async () => !pending.current.size || confirm({ title: 'Unsaved changes', body: 'Some edits have not been saved yet. Continuing will discard those changes.', action: 'Discard changes', danger: true }), [confirm]);
  return <Context.Provider value={{ mark, confirmDiscard }}>{children}{dialog}</Context.Provider>;
}
export function useUnsavedWork() {
  const context = useContext(Context);
  if (!context) throw new Error('UnsavedWorkProvider is missing.');
  return context;
}
export function useUnsavedDocument(key: string, dirty: boolean) {
  const { mark } = useUnsavedWork();
  const instance = useId();
  const identity = `${key}:${instance}`;
  useEffect(() => { mark(identity, dirty); return () => mark(identity, false); }, [mark, identity, dirty]);
}
