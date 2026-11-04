import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { usePreventRemove } from 'expo-router';
import { useConfirm } from '@/components/ui/useConfirm';
import { useUnsavedWork } from './UnsavedWork';

/** Draft owners keep their baseline; successful saves close directly after committing. */
export function useDraftGuard({ dirty, busy = false, onClose, description = 'Your unsaved changes will be discarded.' }: {
  dirty: boolean;
  busy?: boolean;
  onClose: () => void;
  description?: string;
}) {
  const identity = useId();
  const { mark } = useUnsavedWork();
  const { confirm, dialog } = useConfirm();
  const latest = useRef({ dirty, busy, onClose });
  useLayoutEffect(() => { latest.current = { dirty, busy, onClose }; }, [dirty, busy, onClose]);
  useEffect(() => {
    mark(identity, dirty || busy);
    return () => mark(identity, false);
  }, [mark, identity, dirty, busy]);
  const mayDiscard = async () => {
    if (latest.current.busy) return false;
    if (!latest.current.dirty) return true;
    const accepted = await confirm({ title: 'Discard changes?', body: description, action: 'Discard', danger: true });
    return accepted && !latest.current.busy;
  };
  usePreventRemove(dirty || busy, ({ repeat }) => {
    void mayDiscard().then(accepted => {
      if (!accepted) return;
      // Retire the discarded sheet even if another guard then blocks navigation.
      // Expo's repeat disables this guard until its condition changes.
      latest.current.onClose();
      repeat();
    });
  });
  return {
    close: async () => { if (await mayDiscard()) latest.current.onClose(); },
    dismissible: !dirty && !busy,
    dialog,
  };
}
