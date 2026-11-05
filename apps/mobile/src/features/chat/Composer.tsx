import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { FILES_PER_MESSAGE } from '@companybot/core/files';
import { TYPING_PING_MS } from '@companybot/core/typing';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { ActionMenu, Button, IconButton, Stack, Text } from '@/components/ui';
import Photo from '@expo/material-symbols/photo_library.xml';
import Camera from '@expo/material-symbols/photo_camera.xml';
import Attach from '@expo/material-symbols/attach_file.xml';
import Mention from '@expo/material-symbols/alternate_email.xml';
import Microphone from '@expo/material-symbols/mic.xml';
import { ComposerSymbol } from './ComposerSymbol';
import { MessageInput } from '@/components/ui/MessageInput';
import { useTheme } from '@/design';
import { api, errorMessage } from '@/lib/api';
import { useMutation, useQuery, useWorkspace } from '@/lib/convex';
import { useFileUpload, type PickedFile } from '@/lib/fileUpload';
import { convexUrl } from '@/lib/config';
import { changeDraft, readDraft, sendChatDraft, useChatDraft } from './drafts';
import { useDictation } from './useDictation';
import { draftMentions, intactMention, rebaseMentions, recordMentions } from './logic';
import { showSending } from './showSending';
import { MentionPicker } from './MentionPicker';
import { ComposerAttachments } from './ComposerAttachments';
import { ComposerDetails } from './ComposerDetails';

export function Composer({ chatId, threadId }: { chatId: Id<'chats'>; threadId?: Id<'chatMessages'> }) {
  const chats = useQuery(api.chats.list);
  const team = useQuery(api.workspace.team);
  const skills = useQuery(api.skills.list);
  const workspace = useWorkspace();
  const send = useMutation(api.messages.send, showSending);
  const discard = useMutation(api.files.discard);
  const ping = useMutation(api.typing.ping);
  const upload = useFileUpload();
  const { colors, spacing } = useTheme();
  const key = `companybot.draft:${convexUrl}:${chats?.me ?? 'loading'}:${workspace?.id}:${chatId}:${threadId ?? 'main'}`;
  const draft = useChatDraft(key);
  const dictation = useDictation((text) => changeDraft(key, (d) => ({ ...d, text: `${d.text}${d.text && !/\s$/.test(d.text) ? ' ' : ''}${text}` })));
  const ready = draft.ready && !!chats?.me && !!workspace?.id;
  const busy = !!draft.sending;
  const [picking, setPicking] = useState(false);
  const [mentionsOpen, setMentionsOpen] = useState(false);
  const [fileError, setFileError] = useState<string>();
  const lastPing = useRef(0);
  const pickerLock = useRef(false);
  const edit = (text: string) => {
    changeDraft(key, (d) => ({ ...d, text, mentions: rebaseMentions(d.text, text, d.mentions) }));
    if (Date.now() - lastPing.current > TYPING_PING_MS) { lastPing.current = Date.now(); void ping({ chatId, threadId }).catch(() => {}); }
  };
  const addFiles = async (source: 'files' | 'photos' | 'camera') => {
    if (pickerLock.current || !ready || readDraft(key).sending) return;
    pickerLock.current = true;
    setPicking(true); setFileError(undefined);
    try {
      let assets: PickedFile[];
      if (source === 'files') {
        const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
        if (result.canceled) return;
        assets = result.assets;
      } else {
        if (source === 'camera' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) throw new Error('Allow camera access in system settings to take a photo.');
        const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible };
        const result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync({ ...options, allowsMultipleSelection: true, selectionLimit: FILES_PER_MESSAGE - readDraft(key).files.length });
        if (result.canceled) return;
        assets = result.assets.map((asset) => ({ uri: asset.uri, name: asset.fileName ?? `Photo-${Date.now()}.jpg`, size: asset.fileSize, file: asset.file }));
      }
      const room = FILES_PER_MESSAGE - readDraft(key).files.length;
      if (assets.length > room) setFileError(`Attach up to ${FILES_PER_MESSAGE} files per message.`);
      const pending = assets.slice(0, Math.max(0, room)).map((asset) => ({ asset, key: `${Date.now()}:${Math.random()}` }));
      changeDraft(key, (d) => ({ ...d, files: [...d.files, ...pending.map(({ asset, key: fileKey }) => ({ key: fileKey, name: asset.name }))] }));
      // Serialize reads/uploads to bound peak memory on phones with ten large attachments.
      for (const { asset, key: fileKey } of pending) {
        if (!readDraft(key).files.some((file) => file.key === fileKey)) continue;
        await upload(asset).then((file) => {
          if (!readDraft(key).files.some((f) => f.key === fileKey)) { void discard({ file }).catch(() => {}); return; }
          changeDraft(key, (d) => ({ ...d, files: d.files.map((f) => f.key === fileKey ? { ...f, file, uploadedAt: Date.now() } : f) }));
        }, (error: unknown) => changeDraft(key, (d) => ({ ...d, files: d.files.map((f) => f.key === fileKey ? { ...f, error: errorMessage(error) } : f) })));
      }
    } catch (error) { setFileError(errorMessage(error)); } finally { pickerLock.current = false; setPicking(false); }
  };
  const removeFile = (fileKey: string) => {
    if (readDraft(key).sending) return;
    const file = readDraft(key).files.find((f) => f.key === fileKey)?.file;
    if (file) void discard({ file }).catch((error: unknown) => setFileError(errorMessage(error)));
    changeDraft(key, (d) => ({ ...d, files: d.files.filter((f) => f.key !== fileKey) }));
  };
  const directory = [...(team?.members.map((p) => ({ id: p.userId, name: p.name || p.email, kind: 'user' as const, detail: p.email })) ?? []), ...(chats?.agents.map((a) => ({ id: a._id, name: a.name, kind: 'agent' as const, detail: a.description })) ?? []), ...(skills?.filter((s) => !s.trash).map((s) => ({ id: s.id, name: s.name, kind: 'skill' as const })) ?? [])];
  const submit = () => {
    if (!ready || team === undefined || skills === undefined || picking || dictation.state !== 'idle') return;
    void sendChatDraft(key, async current => {
      if (current.mentions.some(span => intactMention(current.text, span) && !directory.some(item => item.kind === span.kind && item.id === span.id))) throw new Error('A mentioned teammate or skill is no longer available. Remove or reselect that mention.');
      const mentioned = draftMentions(current.text, directory, current.mentions);
      await send({ chatId, threadId, text: current.text, attachments: current.files.flatMap((f) => f.file ? [f.file] : []), mentions: { userIds: mentioned.filter((p) => p.kind === 'user').map((p) => p.id as Id<'users'>), agentIds: mentioned.filter((p) => p.kind === 'agent').map((p) => p.id as Id<'agents'>), skillIds: mentioned.filter((p) => p.kind === 'skill').map((p) => p.id), recordIds: recordMentions(current.text) as Id<'records'>[] } });
      lastPing.current = 0;
    });
  };
  return <View style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.xs }}>
    {!busy && <ComposerAttachments files={draft.files.map(file => ({ key: file.key, name: file.name, ready: !!file.file, error: file.error }))} onRemove={removeFile} />}
    <ComposerDetails issues={[
      ...(draft.sendError ? [{ label: 'Message not sent', message: `Your draft and attachments are kept. ${draft.sendError}` }] : []),
      ...(fileError ? [{ label: 'Attachment issue', message: fileError }] : []),
      ...(dictation.error ? [{ label: 'Dictation issue', message: dictation.error }] : []),
    ]} mentions={busy ? [] : draft.mentions} />
    <MessageInput accessibilityLabel={threadId ? 'Reply in thread' : 'Message'} placeholder={threadId ? 'Reply…' : 'Message…'} value={busy ? '' : draft.text} onChangeText={edit} editable={ready && !busy}
      leading={
      <ActionMenu label="Add to message" actions={[
        { id: 'photos', title: 'Photo library', icon: process.env.EXPO_OS === 'ios' ? 'photo' : Photo, disabled: !ready || picking || busy || draft.files.length >= FILES_PER_MESSAGE },
        { id: 'camera', title: 'Take a photo', icon: process.env.EXPO_OS === 'ios' ? 'camera' : Camera, disabled: !ready || picking || busy || draft.files.length >= FILES_PER_MESSAGE },
        { id: 'files', title: 'Choose files', icon: process.env.EXPO_OS === 'ios' ? 'paperclip' : Attach, disabled: !ready || picking || busy || draft.files.length >= FILES_PER_MESSAGE },
        { id: 'mention', title: 'Mention…', icon: process.env.EXPO_OS === 'ios' ? 'at' : Mention, disabled: !ready || busy },
        { id: 'dictate', title: 'Dictate message', icon: process.env.EXPO_OS === 'ios' ? 'mic' : Microphone, disabled: !ready || busy || dictation.state !== 'idle' },
      ]} onAction={action => {
        if (!ready || readDraft(key).sending) return;
        if (action === 'photos' || action === 'camera' || action === 'files') void addFiles(action);
        else if (action === 'mention') setMentionsOpen(true);
        else if (action === 'dictate') void dictation.toggle();
      }}>
        {picking ? <ActivityIndicator color={colors.muted} accessibilityLabel="Adding files" /> : <ComposerSymbol name="add" color={colors.muted} />}
      </ActionMenu>
      }
      trailing={
      <IconButton label="Send message" accessibilityState={{ busy }} disabled={!ready || busy || team === undefined || skills === undefined || picking || dictation.state !== 'idle' || (!draft.text.trim() && !draft.files.length) || draft.files.some((f) => !f.file)} onPress={submit}>
        {busy ? <ActivityIndicator color={colors.link} /> : <ComposerSymbol name="send" color={colors.link} />}
      </IconButton>
      } />
    {dictation.state !== 'idle' && <Stack horizontal gap="sm"><Text tone="muted" variant="caption" accessibilityLiveRegion="polite" style={{ flex: 1 }}>{dictation.state === 'recording' ? 'Recording…' : dictation.state === 'transcribing' ? 'Transcribing…' : 'Preparing microphone…'}</Text>{dictation.state === 'recording' && <Button label="Stop" variant="secondary" accessibilityLabel="Stop dictation and transcribe" onPress={() => void dictation.toggle()} />}<Button label="Cancel" variant="ghost" accessibilityLabel="Cancel dictation" onPress={dictation.cancel} /></Stack>}
    {mentionsOpen && <MentionPicker directory={directory} onClose={() => setMentionsOpen(false)} onPick={(token, mention) => { changeDraft(key, d => { const prefix = `${d.text}${d.text && !/\s$/.test(d.text) ? ' ' : ''}`; return { ...d, text: `${prefix}${token} `, mentions: mention ? [...d.mentions, { ...mention, start: prefix.length, end: prefix.length + token.length }] : d.mentions }; }); setMentionsOpen(false); }} />}

  </View>;
}
