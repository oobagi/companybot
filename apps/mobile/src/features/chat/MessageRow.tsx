import { actionLabel, toolLine } from '@companybot/core/action-words';
import { formatFileSize, isImageType } from '@companybot/core/files';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { memo, useEffect, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { Avatar, Badge, Button, Card, ErrorState, Field, Stack, Text, useConfirm } from '@/components/ui';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { ActionMenu, type Action } from '@/components/ui/ActionMenu';
import { ProfileLink } from './Profile';
import { Approvals } from './Approval';
import { Dialog } from './Dialog';
import { openContentLink } from './links';
import { RichText } from './RichText';
import { Widget } from './Widgets';
import type { Message } from './types';
import { canShareReply, effectivePrivacy } from './access';

export const MessageRow = memo(function MessageRow({ row, readOnly = false, inThread = false, highlighted = false, dayLabel, onStreamVisibility }: { row: Message; readOnly?: boolean; inThread?: boolean; highlighted?: boolean; dayLabel?: string; onStreamVisibility?: (id: string, visible: boolean) => void }) {
  const live = useQuery(api.messages.stream, row.status === 'streaming' ? { messageId: row._id } : 'skip');
  const message = live ? { ...row, ...live, privacy: effectivePrivacy(row.privacy, live.privacy) } : row;
  const react = useMutation(api.messages.react);
  const remove = useMutation(api.messages.remove);
  const hidePreview = useMutation(api.messages.hidePreview);
  const share = useMutation(api.messages.share);
  const confirmation = useConfirm();
  const { colors, spacing } = useTheme();
  const task = useTask();
  const [dialog, setDialog] = useState<'reaction' | 'edit' | 'delete' | 'stats'>();
  const [emoji, setEmoji] = useState('');
  const [photo, setPhoto] = useState<string>();
  const hasApproval = message.parts.some((p) => p.type === 'approval');
  const streamVisible = row.status === 'streaming' && (!!message.privacy?.hidden || hasApproval);
  useEffect(() => {
    onStreamVisibility?.(row._id, streamVisible);
    return () => { if (streamVisible) onStreamVisibility?.(row._id, false); };
  }, [row._id, streamVisible, onStreamVisibility]);
  const day = dayLabel && <Text variant="caption" tone="muted" accessibilityRole="header" style={{ textAlign: 'center', paddingVertical: spacing.sm }}>{dayLabel}</Text>;
  const shareable = canShareReply(message, readOnly);
  const thread = () => router.push({ pathname: '/chat/[chatId]/thread/[threadId]', params: { chatId: message.chatId, threadId: message._id } });
  if (message.privacy?.hidden) return <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md }}>{day}<Text tone="muted">🔒 {message.privacy.label}</Text></View>;
  if (message.status === 'streaming' && !hasApproval) return null;
  if (message.pause && !message.deleted) return <View>{day}<Paused message={message} readOnly={readOnly} /></View>;
  const actions: Action[] = [
    ...(!readOnly ? [{ id: 'react', title: 'React', icon: 'face.smiling', items: [...['👍', '❤️', '😂', '🎉', '👀', '✅'].map(value => ({ id: `react:${value}`, title: value, disabled: task.busy, selected: message.reactions.some(reaction => reaction.emoji === value && reaction.mine) })), { id: 'custom-reaction', title: 'Choose another…' }] } as Action] : []),
    ...(!readOnly && !inThread && !message.threadId ? [{ id: 'thread', title: 'Reply in thread', icon: 'bubble.left' as const }] : []),
    { id: 'copy', title: 'Copy text', icon: 'doc.on.doc' },
    ...(message.stats ? [{ id: 'stats', title: 'Reply details', icon: 'info.circle' as const }] : []),
    ...(!readOnly && message.mine ? [{ id: 'edit', title: 'Edit', icon: 'pencil' as const, disabled: task.busy }, { id: 'delete', title: 'Delete', icon: 'trash' as const, destructive: true, disabled: task.busy }] : []),
  ];
  const perform = (action: string) => {
    if (action.startsWith('react:')) void task.run(() => react({ messageId: message._id, emoji: action.slice(6) }));
    else if (action === 'custom-reaction') setDialog('reaction');
    else if (action === 'thread') thread();
    else if (action === 'copy') void task.run(() => Clipboard.setStringAsync(message.text));
    else if (action === 'edit') setDialog('edit');
    else if (action === 'delete' || action === 'stats') setDialog(action);
  };
  return <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm, backgroundColor: highlighted ? colors.selected : undefined }}>
    {day}
    {confirmation.dialog}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <ProfileLink who={message.author}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Avatar name={message.author.name} image={message.author.image} agent={message.author.type === 'agent'} size="sm" />
            <View style={{ flex: 1, minWidth: 0, gap: spacing.xs }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
                <Text variant="label" style={{ flexShrink: 1 }}>{message.author.name}</Text>
                {message.author.type === 'agent' && <Badge label="Bot" />}
              </View>
              <Text variant="caption" tone="muted">{new Date(message.shownAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{message.editedAt ? ' · edited' : ''}</Text>
            </View>
          </View>
        </ProfileLink>
      </View>
      {!message.deleted && <ActionMenu label={`Actions for ${message.author.name}'s message`} actions={actions} onAction={perform} />}
    </View>
    {message.author.for && <ProfileLink who={message.author.for}><Text variant="caption" tone="muted">Sent for {message.author.for.name}</Text></ProfileLink>}
    {message.deleted ? <Text tone="muted">This message was deleted.</Text> : <>
      {message.automation && <Badge label={`Automation · ${message.automation.name}`} />}
      {message.ask && <Text variant="caption" tone="muted">{message.ask.from} asked {message.ask.to}</Text>}
      {message.privacy && <Stack gap="xs"><Text variant="caption" tone="muted">{message.privacy.sharedBy ? '' : '🔒 '}{message.privacy.label}</Text>{message.privacy.why && <Text variant="caption" tone="muted">{message.privacy.why}</Text>}{shareable && <Button label="Share reply to chat" variant="ghost" loading={task.busy} onPress={() => void task.run(async () => { if (await confirmation.confirm({ title: 'Share this reply?', body: message.privacy!.share!, action: 'Share reply' })) await share({ messageId: message._id }); })} />}</Stack>}
      {message.author.type === 'agent' && message.parts.length ? <Stack gap="sm">{message.parts.map((part, index) => part.type === 'text' ? <RichText key={index} value={part.text} /> : part.type === 'tool' ? <ToolLine key={part.id} part={part} replyId={message._id} /> : part.type === 'widget' ? <Widget key={part.id} widget={part.widget} /> : null)}</Stack> : <RichText value={message.text} plain={message.author.type !== 'agent'} />}
      {hasApproval && <Approvals message={message} />}
      {message.attachments.map((file, i) => <Pressable key={i} accessibilityRole="button" accessibilityLabel={`Open ${file.name}`} disabled={!file.url} onPress={() => { if (!file.url) return; if (isImageType(file.type)) setPhoto(file.url); else void task.run(() => openContentLink(file.url!)); }}>
        {file.url && isImageType(file.type) && <Image source={{ uri: file.url }} accessibilityLabel={file.name} resizeMode="contain" style={{ width: '100%', height: 220, backgroundColor: colors.surface }} />}
        <Text tone={file.url ? 'link' : 'muted'}>{file.name} · {formatFileSize(file.size)}{!file.url ? ' · unavailable' : ''}</Text>
      </Pressable>)}
      {message.linkPreviews.map((preview) => <Card key={preview.url}><Pressable accessibilityRole="link" onPress={() => void task.run(() => openContentLink(preview.url))}><Text variant="label">{preview.title ?? preview.siteName ?? preview.url}</Text>{preview.description && <Text tone="muted">{preview.description}</Text>}{preview.imageUrl && <Image source={{ uri: preview.imageUrl }} style={{ width: '100%', height: 160 }} resizeMode="cover" accessibilityLabel={preview.title ?? 'Link preview'} />}</Pressable>{message.mine && !readOnly && <Button label="Hide preview" variant="ghost" onPress={() => void task.run(() => hidePreview({ messageId: message._id, url: preview.url }))} />}</Card>)}
      {message.status === 'error' && <ErrorState message={message.error ?? 'The reply failed.'} />}
      {message.stoppedBy && <Text variant="caption" tone="muted">Stopped by {message.stoppedBy}</Text>}
      {message.reactions.length > 0 && <Stack horizontal gap="xs" style={{ flexWrap: 'wrap' }}>{message.reactions.map((reaction) => <Button key={reaction.emoji} label={`${reaction.emoji} ${reaction.count}`} accessibilityLabel={`${reaction.emoji}: ${reaction.people.map((p) => p.name).join(', ')}${reaction.mine ? '. You reacted.' : ''}`} variant={reaction.mine ? 'secondary' : 'ghost'} disabled={readOnly || task.busy} onPress={() => void task.run(() => react({ messageId: message._id, emoji: reaction.emoji }))} />)}</Stack>}
      {!inThread && !message.threadId && message.replyCount > 0 && <Button label={`${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}`} variant="ghost" onPress={thread} />}
    </>}
    {task.error && <ErrorState message={task.error} />}
    {dialog === 'edit' && <EditMessage message={message} onClose={() => setDialog(undefined)} />}
    {dialog && dialog !== 'edit' && <Dialog busy={task.busy} title={dialog === 'delete' ? 'Delete message?' : dialog === 'stats' ? 'Reply details' : 'Add a reaction'} onClose={() => { if (!task.busy) setDialog(undefined); }}>
      {task.error && <ErrorState message={task.error} />}
      {dialog === 'reaction' && <><Field label="Reaction" hint="Use your keyboard’s emoji picker." value={emoji} onChangeText={setEmoji} maxLength={16} autoFocus /><Button label="React" disabled={!emoji.trim()} loading={task.busy} onPress={() => void task.run(async () => { await react({ messageId: message._id, emoji: emoji.trim() }); setDialog(undefined); })} /></>}
      {dialog === 'delete' && <><Text>This deletes the message and its attachments for everyone. This cannot be undone.</Text><Button label="Delete message" variant="danger" loading={task.busy} onPress={() => void task.run(async () => { await remove({ messageId: message._id }); setDialog(undefined); })} /></>}
      {dialog === 'stats' && message.stats && Object.entries(message.stats).map(([name, value]) => <Stack key={name} gap="xs"><Text variant="label">{name}</Text><Text selectable>{typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}</Text></Stack>)}
    </Dialog>}
    {photo && <Dialog title="Picture" onClose={() => setPhoto(undefined)}><Image source={{ uri: photo }} resizeMode="contain" style={{ width: '100%', height: 480 }} accessibilityLabel="Attached picture" /><Button label="Open original" variant="secondary" onPress={() => void task.run(() => openContentLink(photo))} /></Dialog>}
  </View>;
});


/** Mount the navigation guard only for the open editor, not for every timeline row. */
function EditMessage({ message, onClose }: { message: Message; onClose: () => void }) {
  const [baseline] = useState(message.text);
  const [text, setText] = useState(baseline);
  const edit = useMutation(api.messages.edit);
  const task = useTask();
  const stale = baseline !== message.text;
  const guard = useDraftGuard({ dirty: text !== baseline, busy: task.busy, onClose, description: 'Your message edits will be discarded.' });
  return <Dialog title="Edit message" busy={task.busy} dismissible={guard.dismissible} onClose={() => void guard.close()}>
    {guard.dialog}
    {task.error && <ErrorState message={task.error} />}
    {stale && <ErrorState message="This message changed on another device. Close and reopen the editor before saving." />}
    <Field label="Message" multiline value={text} onChangeText={setText} editable={!task.busy} autoFocus />
    <Button label="Save" disabled={!text.trim() || text === baseline || stale} loading={task.busy} onPress={() => void task.run(async () => { await edit({ messageId: message._id, text }); onClose(); })} />
  </Dialog>;
}

function Paused({ message, readOnly }: { message: Message; readOnly: boolean }) {
  const decide = useMutation(api.chains.decide);
  const task = useTask();
  return <Card><Text>{message.text}</Text>{!readOnly && message.pause?.canDecide ? <Stack horizontal><Button label="Continue" loading={task.busy} onPress={() => void task.run(() => decide({ messageId: message._id, action: 'continue' }))} /><Button label="Stop" variant="secondary" disabled={task.busy} onPress={() => void task.run(() => decide({ messageId: message._id, action: 'stop' }))} /></Stack> : <Text tone="muted">{message.pause?.status === 'paused' ? `Waiting for ${message.pause.for}` : `${message.pause?.status} ${message.pause?.by ?? ''}`}</Text>}{task.error && <ErrorState message={task.error} />}</Card>;
}

function ToolLine({ part, replyId }: { part: Extract<Message['parts'][number], { type: 'tool' }>; replyId: Message['_id'] }) {
  const [open, setOpen] = useState(false);
  const calls = useQuery(api.activity.forReply, open ? { replyId } : 'skip');
  const call = calls?.find((c) => c.callId === part.id);
  const label = toolLine(part.label ?? actionLabel(part.name), part.status);
  return <><Button label={label} variant="ghost" onPress={() => {
    if (part.opens?.kind === 'message') router.push({ pathname: '/chat/[chatId]', params: { chatId: part.opens.chatId, messageId: part.opens.messageId } });
    else if (part.opens) router.push({ pathname: '/chat/[chatId]/thread/[threadId]', params: { chatId: part.opens.chatId, threadId: part.opens.messageId } });
    else setOpen(true);
  }} />{open && <Dialog title={label} onClose={() => setOpen(false)}><Text selectable>{calls === undefined ? 'Loading…' : call ? JSON.stringify(call, null, 2) : 'No details saved.'}</Text></Dialog>}</>;
}
