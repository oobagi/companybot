import { useLayoutEffect, useState } from 'react';
import { useTask } from '@/lib/useTask';
import { useUnsavedWork } from '@/lib/UnsavedWork';
import { createWorkspaceTransition } from './workspaceTransition';

/** Ask before acquiring useTask's global lock, then protect the entire async transition. */
export function useWorkspaceTransition() {
  const task = useTask();
  const { confirmDiscard } = useUnsavedWork();
  const [transition] = useState(createWorkspaceTransition);
  useLayoutEffect(() => transition.retain(), [transition]);
  return {
    ...task,
    run: (work: (isCurrent: () => boolean) => Promise<unknown>, approve = confirmDiscard) => transition.run(approve, isCurrent => task.run(() => work(isCurrent))),
  };
}
