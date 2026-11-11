import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { imageMaxBytes, imageMaxMb, imageTypes, pictureLimits } from '@companybot/core/images';
import { useAuthToken } from '@convex-dev/auth/react';
import { fetch } from 'expo/fetch';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { validateImageFile } from '@/lib/imageFile';
import { Platform } from 'react-native';
import { useLayoutEffect } from 'react';
import { Avatar, Button, ErrorState, Stack, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery, useWorkspace } from '@/lib/convex';
import { useTask } from '@/lib/useTask';

export function ImageControl({ of, name, image, disabled = false, agent = false, onBusyChange }: { of: 'workspace' | 'me' | Id<'agents'>; name: string; image?: string | null; disabled?: boolean; agent?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const endpoint = useQuery(api.images.uploadEndpoint);
  const workspace = useWorkspace();
  const token = useAuthToken();
  const save = useMutation(api.images.set);
  const task = useTask();
  // The containing editor must protect dismissal during both upload and removal.
  // Publish before paint, and release the guard if this control is unmounted.
  useLayoutEffect(() => {
    onBusyChange?.(task.busy);
    return () => onBusyChange?.(false);
  }, [onBusyChange, task.busy]);
  const upload = () => task.run(async () => {
    if (!endpoint || !workspace || !token) throw new Error('Still connecting. Try again.');
    const result = await DocumentPicker.getDocumentAsync({ type: [...imageTypes], copyToCacheDirectory: true });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    if ((asset.size ?? 0) > imageMaxBytes) throw new Error(`Pick an image under ${imageMaxMb} MB.`);
    const file = Platform.OS === 'web' ? asset.file : new File(asset.uri);
    if (!file) throw new Error('The image could not be read.');
    await validateImageFile(file);
    const response = await fetch(`${endpoint}?workspaceId=${encodeURIComponent(workspace.id)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: file });
    const body = await response.json() as { storageId?: Id<'_storage'>; error?: string };
    if (!response.ok || !body.storageId) throw new Error(body.error ?? 'The image upload failed.');
    await save({ of, file: body.storageId });
  });
  return <Stack><Stack horizontal style={{ flexWrap: 'wrap' }}><Avatar name={name} image={image} agent={agent} size="lg" />
    {!disabled && <><Button label="Change picture" variant="secondary" loading={task.busy} onPress={() => void upload()} />{image && <Button label="Remove picture" variant="ghost" disabled={task.busy} onPress={() => void task.run(() => save({ of, file: null }))} />}</>}
  </Stack><Text variant="caption" tone="muted">{pictureLimits}.</Text>{task.error && <ErrorState message={task.error} />}</Stack>;
}
