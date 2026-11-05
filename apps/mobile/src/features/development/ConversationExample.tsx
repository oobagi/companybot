import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Button, IconButton, Screen, Stack, Text } from '@/components/ui';
import { MessageInput } from '@/components/ui/MessageInput';
import { ChatActivity, type ActivityAgent } from '@/features/chat/ChatActivity';
import { ComposerAttachments, type ComposerAttachment } from '@/features/chat/ComposerAttachments';
import { ComposerDetails } from '@/features/chat/ComposerDetails';
import { ComposerSymbol } from '@/features/chat/ComposerSymbol';
import { useTheme } from '@/design';

const sampleFiles: ComposerAttachment[] = Array.from({ length: 10 }, (_, index) => ({ key: String(index), name: `Project report ${index + 1} with a long descriptive filename.pdf`, ready: index > 1, ...(index === 1 ? { error: 'Upload failed. Remove this file and choose it again.' } : {}) }));
const sampleAgents: ActivityAgent[] = Array.from({ length: 10 }, (_, index) => ({ turnId: String(index), name: `Research assistant ${index + 1}`, step: 'Searching the workspace for the latest project details and related documents…', canStop: index !== 9, stopping: false }));

/** Local data only: stress the real footer components without uploading files or starting agents. */
export function ConversationExample() {
  const [files, setFiles] = useState(sampleFiles);
  const [agents, setAgents] = useState(sampleAgents);
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const { colors, spacing } = useTheme();
  return <Screen keyboard>
    <ScrollView style={{ flex: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>
      <Text>The conversation keeps its space when ten attachments, ten agents and ten typists are present.</Text>
      <Button label="Reset example" variant="ghost" onPress={() => { setFiles(sampleFiles); setAgents(sampleAgents); setText(''); setSent(false); }} />
      {sent && <Text accessibilityLiveRegion="polite">Example message sent locally.</Text>}
    </ScrollView>
    <ChatActivity people={Array.from({ length: 10 }, (_, index) => ({ id: String(index), name: `Teammate ${index + 1}` }))} agents={agents} onStop={id => setAgents(previous => previous.filter(agent => agent.turnId !== id))} />
    <Stack gap="xs" style={{ paddingTop: spacing.sm }}>
      <ComposerAttachments files={files} onRemove={key => setFiles(previous => previous.filter(file => file.key !== key))} />
      <ComposerDetails issues={files.some(file => file.error) ? [{ label: 'Attachment problem', message: 'A file could not upload. Your message is kept. Open attachments, remove the failed file and choose it again.' }] : []} mentions={Array.from({ length: 10 }, (_, index) => ({ name: `Teammate with a long display name ${index + 1}`, detail: `teammate${index + 1}@example.com` }))} />
      <MessageInput accessibilityLabel="Example message" value={text} onChangeText={setText} placeholder="Message…"
        leading={<IconButton label="Add example attachment" onPress={() => setFiles(previous => [...previous, { key: `local-${Date.now()}`, name: 'Example attachment.pdf', ready: true }])}><ComposerSymbol name="add" color={colors.muted} /></IconButton>}
        trailing={<IconButton label="Send example message" disabled={!text.trim()} onPress={() => { setText(''); setSent(true); }}><ComposerSymbol name="send" color={colors.link} /></IconButton>} />
    </Stack>
  </Screen>;
}
