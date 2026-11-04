import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { FILE_MAX_BYTES, fileError } from '@companybot/core/files';
import { useAuthToken } from '@convex-dev/auth/react';
import { File } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { Platform } from 'react-native';
import { api } from './api';
import { useQuery, useWorkspace } from './convex';

export type PickedFile = { uri: string; name: string; size?: number; file?: globalThis.File };

/** Upload bytes, never a multipart envelope: the backend sniffs and owns validation. */
export function useFileUpload() {
  const endpoint = useQuery(api.files.uploadEndpoint);
  const token = useAuthToken();
  const workspace = useWorkspace();
  return async (picked: PickedFile): Promise<Id<'_storage'>> => {
    if (!endpoint || !token || !workspace) throw new Error('Still connecting. Try again in a moment.');
    const file = Platform.OS === 'web' ? picked.file : new File(picked.uri);
    if (!file) throw new Error('This file is no longer available. Pick it again.');
    if (file.size > FILE_MAX_BYTES) throw new Error('Pick a file under 20 MB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const invalid = fileError(bytes, picked.name, file.size);
    if (invalid) throw new Error(invalid);
    const url = `${endpoint}?${new URLSearchParams({ workspaceId: workspace.id, name: picked.name })}`;
    const response = await expoFetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: file });
    const result = await response.json() as { storageId?: string; error?: string };
    if (!response.ok || !result.storageId) throw new Error(result.error ?? 'The upload failed. Please try again.');
    return result.storageId as Id<'_storage'>;
  };
}
