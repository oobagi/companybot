import { useId, useLayoutEffect, useRef, useState } from 'react';
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
  const [completed, setCompleted] = useState(false);
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { mark } = useUnsavedWork();
  const { confirm, dialog } = useConfirm();
  const latest = useRef({ dirty, busy, onClose });
  useLayoutEffect(() => { latest.current = { dirty, busy, onClose }; }, [dirty, busy, onClose]);
  useLayoutEffect(() => {
    mark(identity, !completed && dirty, !completed && busy);
    return () => mark(identity, false);
  }, [mark, identity, dirty, busy, completed]);
  const mayDiscard = async () => {
    if (latest.current.busy) return false;
    if (!latest.current.dirty) return true;
    const accepted = await confirm({ title: 'Discard changes?', body: description, action: 'Discard', danger: true });
    return accepted && !latest.current.busy;
  };
  const disablePrevention = usePreventRemove(!completed && (dirty || busy), ({ repeat }) => {
    void mayDiscard().then(accepted => {
      if (!accepted) return;
      // Retire the discarded sheet even if another guard then blocks navigation.
      // Expo's repeat disables this guard until its condition changes.
      latest.current.onClose();
      repeat();
    });
  });
  return {
    /** After a successful commit, retire only this draft before closing or navigating. */
    complete: () => {
      mark(identity, false);
      // A subscription can remove an archived entity before its mutation promise resolves.
      if (!mounted.current) return;
      setCompleted(true);
      disablePrevention();
    },
    close: async () => { if (await mayDiscard()) latest.current.onClose(); },
    dismissible: !dirty && !busy,
    dialog,
  };
}
