import { useEffect } from 'react';
import { router } from 'expo-router';
import { AppState } from 'react-native';
import { useConvexConnectionState } from 'convex/react';
import { useWorkspace } from '@/lib/convex';
import { useUnsavedWork } from '@/lib/UnsavedWork';
import { useNotifications } from './NotificationsProvider';

/** Mount inside WorkspaceProvider, alongside the workspace navigator. */
export function NotificationNavigation() {
  const workspace = useWorkspace();
  const { isWebSocketConnected } = useConvexConnectionState();
  const { confirmDiscard } = useUnsavedWork();
  const { pending, resolvePending, approvePending, finishPending, reportError } = useNotifications();
  useEffect(() => {
    if (!pending || !workspace || !isWebSocketConnected) return;
    let active = true;
    let running = false;
    const open = async () => {
      if (running || !active || AppState.currentState !== 'active') return;
      running = true;
      try {
        // Resolve again after a workspace switch: membership/messages may have changed meanwhile.
        const destination = await resolvePending();
        if (!active) return;
        if (!destination) { finishPending(pending.deliveryId); return; }
        if (!pending.approved && !await confirmDiscard()) { finishPending(pending.deliveryId); return; }
        if (!active) return;
        if (workspace.id !== destination.workspaceId) {
          approvePending(pending.deliveryId, destination);
          if (!workspace.open(destination.workspaceId)) {
            finishPending(pending.deliveryId);
            reportError(new Error('This workspace is no longer available.'));
          }
          return;
        }
        if (destination.threadId) router.push({ pathname: '/chat/[chatId]/thread/[threadId]', params: { chatId: destination.chatId, threadId: destination.threadId, messageId: destination.messageId } });
        else router.push({ pathname: '/chat/[chatId]', params: { chatId: destination.chatId, messageId: destination.messageId } });
        finishPending(pending.deliveryId);
      } catch (error) { if (active) reportError(error); }
      finally { running = false; }
    };
    void open();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void open(); });
    return () => { active = false; subscription.remove(); };
  }, [pending, workspace, isWebSocketConnected, confirmDiscard, resolvePending, approvePending, finishPending, reportError]);
  return null;
}
