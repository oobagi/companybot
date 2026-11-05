import { useState } from 'react';
import { Keyboard } from 'react-native';
import { Button, EditorSheet, EmptyState, ListRow, Stack, Text } from '@/components/ui';

export type ComposerAttachment = { key: string; name: string; ready: boolean; error?: string };

/** The composer stays one compact summary; the native sheet owns the growing file list. */
export function ComposerAttachments({ files, disabled = false, onRemove }: { files: readonly ComposerAttachment[]; disabled?: boolean; onRemove: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const failed = files.filter(file => file.error).length;
  const uploading = files.filter(file => !file.ready && !file.error).length;
  return <>
    {!!files.length && <Button label={`${files.length} ${files.length === 1 ? 'attachment' : 'attachments'}${failed ? ` · ${failed} failed` : uploading ? ` · ${uploading} uploading` : ''}`} variant="ghost" disabled={disabled} onPress={() => { Keyboard.dismiss(); setOpen(true); }} />}
    {open && <EditorSheet title="Message attachments" busy={disabled} onClose={() => setOpen(false)}>
      <Text tone="muted">These files will be sent with your message. Closing keeps them attached.</Text>
      {files.length ? <Stack gap="none">{files.map(file => <ListRow key={file.key} title={file.name} description={file.error ?? (file.ready ? 'Ready to send' : 'Uploading…')} trailing={<Button label="Remove" accessibilityLabel={`Remove ${file.name}`} variant="ghost" disabled={disabled} onPress={() => onRemove(file.key)} />} />)}</Stack> : <EmptyState title="No attachments" description="Add files from the message’s Add menu." layout="inline" />}
    </EditorSheet>}
  </>;
}
