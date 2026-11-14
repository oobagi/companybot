import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { router } from 'expo-router';
import { EditorSheet, ErrorState, ListRow, useConfirm } from '@/components/ui';
import { usePinAction } from '@/features/pins/usePins';
import { api } from '@/lib/api';
import { useMutation } from '@/lib/convex';
import { useTask } from '@/lib/useTask';

/** What a long-pressed chat list row offers; desktop's row menu. */
export type ChatRowTarget =
  | { kind: 'channel'; chatId: Id<'chats'>; title: string; isDefault: boolean; canManage: boolean }
  | { kind: 'agent'; agentId: Id<'agents'>; dmId: Id<'chats'> | null; title: string }
  | { kind: 'dm'; chatId: Id<'chats'>; title: string }
  | { kind: 'side'; chatId: Id<'chats'>; title: string };

export function ChatRowActions({ target, onClose }: { target: ChatRowTarget; onClose: () => void }) {
  const chatId = target.kind === 'agent' ? target.dmId : target.chatId;
  const pin = usePinAction(chatId ? `chat:${chatId}` : undefined);
  const markRead = useMutation(api.chats.markRead);
  const leave = useMutation(api.chats.leave);
  const closeDm = useMutation(api.chats.closeDm);
  const archive = useMutation(api.trash.move);
  const task = useTask();
  const { confirm, dialog } = useConfirm();
  const act = (work: () => Promise<unknown>) => void task.run(async () => { await work(); onClose(); });
  return <EditorSheet title={target.title} size="content" busy={task.busy} onClose={onClose}>
    {dialog}
    {target.kind === 'channel' && <ListRow title="Members and details" disabled={task.busy} onPress={() => { onClose(); router.push({ pathname: '/chat/[chatId]/details', params: { chatId: target.chatId } }); }} />}
    {chatId && <ListRow title="Mark as read" disabled={task.busy} onPress={() => act(() => markRead({ chatId }))} />}
    {chatId && <ListRow title={pin.label} disabled={task.busy || pin.disabled} onPress={() => { pin.onPress(); onClose(); }} />}
    {target.kind === 'agent' && <ListRow title="Agent settings" disabled={task.busy} onPress={() => { onClose(); router.push({ pathname: '/settings/[section]', params: { section: 'agents', itemId: target.agentId } }); }} />}
    {target.kind === 'channel' && !target.isDefault && <ListRow title="Leave channel" disabled={task.busy} onPress={() => act(() => leave({ chatId: target.chatId }))} />}
    {target.kind === 'dm' && <ListRow title="Close conversation" description="It comes back when someone writes there." disabled={task.busy} onPress={() => act(() => closeDm({ chatId: target.chatId }))} />}
    {((target.kind === 'channel' && target.canManage && !target.isDefault) || target.kind === 'side') && <ListRow title={target.kind === 'side' ? 'Archive' : 'Archive channel'} disabled={task.busy} onPress={() => void task.run(async () => {
      if (!await confirm({ title: `Archive ${target.title}?`, body: target.kind === 'channel' ? 'The channel will close to new messages. Its messages and files are kept.' : 'You can restore it from Archive.', action: 'Archive', danger: true })) return;
      await archive({ kind: 'channel', id: target.chatId }); onClose();
    })} />}
    {(task.error || pin.error) && <ErrorState message={task.error ?? pin.error!} />}
  </EditorSheet>;
}
