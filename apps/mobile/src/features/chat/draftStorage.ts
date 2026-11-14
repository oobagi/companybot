import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { mentionLabel, type MentionSpan } from './logic';

export type DraftFile = { key: string; name: string; file?: Id<'_storage'>; uploadedAt?: number; error?: string };
export type Draft = { text: string; mentions: MentionSpan[]; files: DraftFile[]; ready: boolean; sending?: true; sendError?: string; loadError?: string };
const DAY = 86_400_000;
export const emptyDraft: Draft = { text: '', mentions: [], files: [], ready: false };

export function serializeDraft(draft: Draft, now: number) {
  return JSON.stringify({ companybotDraft: 1, savedAt: now, text: draft.text, mentions: draft.mentions, files: draft.files.filter(file => file.file && file.uploadedAt && now - file.uploadedAt < DAY) });
}
export function deserializeDraft(raw: string | null, now: number): Draft {
  const empty = { ...emptyDraft, ready: true };
  if (!raw) return empty;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ...empty, text: raw }; }
  if (!value || typeof value !== 'object' || !('companybotDraft' in value) || value.companybotDraft !== 1) return { ...empty, text: raw };
  const data = value as Record<string, unknown>;
  if (typeof data.savedAt !== 'number' || now - data.savedAt > 30 * DAY || typeof data.text !== 'string') return empty;
  const text = data.text;
  const mentions = (Array.isArray(data.mentions) ? data.mentions : []).filter((item): item is MentionSpan => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string' && ['user', 'agent', 'skill'].includes(item.kind) && Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) && item.start >= 0 && item.end > item.start && text.slice(item.start, item.end) === mentionLabel(item));
  const files = (Array.isArray(data.files) ? data.files : []).filter((item): item is DraftFile => item && typeof item === 'object' && typeof item.key === 'string' && typeof item.name === 'string' && typeof item.file === 'string' && typeof item.uploadedAt === 'number' && now - item.uploadedAt < DAY).slice(0, 10);
  return { text, mentions, files, ready: true };
}
