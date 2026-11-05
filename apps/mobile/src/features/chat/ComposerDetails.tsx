import { useState } from 'react';
import { Keyboard, View } from 'react-native';
import { Button, EditorSheet, EmptyState, ErrorState, ListRow, Stack, Text } from '@/components/ui';

type MessageIssue = { label: string; message: string };
type Mention = { name: string; detail?: string };

/** Long errors and mention names never compete with the message input for space. */
export function ComposerDetails({ issues, mentions }: { issues: readonly MessageIssue[]; mentions: readonly Mention[] }) {
  const [open, setOpen] = useState(false);
  const label = issues.length ? `${issues[0].label} · Details` : `${mentions.length} ${mentions.length === 1 ? 'mention' : 'mentions'}`;
  return <>
    {(issues.length > 0 || mentions.length > 0) && <View accessibilityLiveRegion="polite">
      <Button label={label} variant="ghost" accessibilityLabel={issues.length ? `${issues.length} message ${issues.length === 1 ? 'issue' : 'issues'}. View details.` : label} accessibilityHint="Opens full details without changing your message." onPress={() => { Keyboard.dismiss(); setOpen(true); }} />
    </View>}
    {open && <EditorSheet title="Message details" onClose={() => setOpen(false)}>
      {issues.map(issue => <Stack key={issue.label} gap="sm"><Text variant="label" accessibilityRole="header">{issue.label}</Text><ErrorState message={issue.message} /></Stack>)}
      {mentions.length > 0 && <Stack gap="none"><Text variant="label" accessibilityRole="header">Mentions</Text>{mentions.map((mention, index) => <ListRow key={index} title={mention.name} description={mention.detail} />)}</Stack>}
      {!issues.length && !mentions.length && <EmptyState layout="inline" title="No message details" description="Close to return to your message." />}
    </EditorSheet>}
  </>;
}
