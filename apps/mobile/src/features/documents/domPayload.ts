import type { Colors } from '@/design';
import type { DocumentCommand } from './commands';
import type { Reference } from './schema';
import type { Snapshot } from './transport';

export type DocumentPayload = {
  pageId: string;
  snapshot: Snapshot;
  latestVersion: number | null;
  retrySignal?: string;
  editable: boolean;
  canCreatePage: boolean;
  dark: boolean;
  colors: Colors;
  references: Record<string, Reference>;
  image?: { url: string; request: number };
  command?: DocumentCommand;
};

// Keep user content inert even in WebView serializers that embed initial props
// in template literals: they must not consume JSON escapes or evaluate interpolation.
export function encodeDocumentPayload(value: DocumentPayload): string {
  return encodeURIComponent(JSON.stringify(value));
}

export function decodeDocumentPayload(value: string): DocumentPayload {
  return JSON.parse(decodeURIComponent(value)) as DocumentPayload;
}
