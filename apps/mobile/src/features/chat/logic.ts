import { linkedRecordId } from '@companybot/core/page-links';

export type Mention = { id: string; name: string; kind: 'user' | 'agent' | 'skill'; detail?: string };
export type MentionSpan = Mention & { start: number; end: number };
export const mentionLabel = (mention: Mention) => `${mention.kind === 'skill' ? '/' : '@'}${mention.name}`;
export const intactMention = (text: string, span: MentionSpan) => text.slice(span.start, span.end) === mentionLabel(span) && !/[\p{L}\p{N}_]/u.test(text[span.end] ?? '') && !/[\p{L}\p{N}_]/u.test(text[span.start - 1] ?? '');

/** TextInput supplies plain text; retain picked identities only while their exact text survives. */
export function rebaseMentions(before: string, after: string, mentions: MentionSpan[]) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length;
  let newEnd = after.length;
  while (end > start && newEnd > start && before[end - 1] === after[newEnd - 1]) { end--; newEnd--; }
  const shift = newEnd - end;
  return mentions.flatMap(mention => {
    const next = mention.end <= start ? mention : mention.start >= end ? { ...mention, start: mention.start + shift, end: mention.end + shift } : null;
    return next && intactMention(after, next) ? [next] : [];
  });
}

/** Explicit picker selections win over ambiguous names; ordinary typed mentions still work. */
export function draftMentions(text: string, directory: Mention[], spans: MentionSpan[]) {
  const intact = spans.filter(span => intactMention(text, span));
  const picked = intact.filter(span => directory.some(item => item.id === span.id && item.kind === span.kind));
  let typed = text;
  for (const span of [...intact].sort((a, b) => b.start - a.start)) typed = `${typed.slice(0, span.start)}${' '.repeat(span.end - span.start)}${typed.slice(span.end)}`;
  return [...new Map([...picked, ...mentionedIn(typed, directory)].map(mention => [`${mention.kind}:${mention.id}`, mention])).values()];
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const recordMentions = (text: string) => [...new Set([...text.matchAll(/\]\(#\/records\/[^/)\s]+\/([a-z0-9]+)\)/g)].map((match) => match[1]!))];

/** Deliberate internal links inserted into human messages remain clickable without treating their prose as Markdown. */
export function plainInternalLinks(text: string): (string | { label: string; href: string })[] {
  const result: (string | { label: string; href: string })[] = [];
  const pattern = /\[([^\]\n]+)\]\((#\/(?:records|pages|chat)\/[^)\s]+|companybot:\/\/page\/[a-z0-9]+)\)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) { if (match.index > offset) result.push(text.slice(offset, match.index)); result.push({ label: match[1]!, href: match[2]! }); offset = match.index + match[0].length; }
  if (offset < text.length) result.push(text.slice(offset));
  return result;
}

/** Longest name wins, word boundaries avoid accidentally pinging Ann when typing Anna. */
export function mentionedIn(text: string, directory: Mention[]) {
  const groups = new Map<string, Mention[]>();
  for (const person of directory) {
    const token = `${person.kind === 'skill' ? '/' : '@'}${person.name}`;
    groups.set(token, [...(groups.get(token) ?? []), person]);
  }
  const tokens = [...groups.keys()].sort((a, b) => b.length - a.length);
  if (!tokens.length) return [];
  const matches = new Set<string>();
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])(${tokens.map(escape).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  for (const match of text.matchAll(pattern)) matches.add(match[2]!);
  // Ambiguous display names must never fan out into multiple unintended recipients.
  return [...matches].flatMap((token) => groups.get(token)!.length === 1 ? groups.get(token)! : []);
}

export type ContentDestination =
  | { kind: 'external'; url: string }
  | { kind: 'path'; path: string; params?: Record<string, string> }
  | { kind: 'database'; key: string };

/** Translate persistent desktop links to native routes; reject unsupported schemes. */
export function contentDestination(href: string): ContentDestination {
  if (/[\u0000-\u001f]/.test(href)) throw new Error('This link is not valid.');
  const record = linkedRecordId(href);
  if (record) return { kind: 'path', path: `/record/${record}` };
  const page = /^companybot:\/\/page\/([a-z0-9]+)$/.exec(href);
  if (page) return { kind: 'path', path: `/pages/${page[1]}` };
  const internal = href.startsWith('#/') ? href.slice(1) : href.startsWith('/') && !href.startsWith('//') ? href : null;
  if (internal) {
    let pieces: string[];
    try { pieces = internal.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw new Error('This link is not valid.'); }
    if (pieces.some((p) => /[/?#\u0000-\u001f]/.test(p) || p === '.' || p === '..')) throw new Error('This link is not valid.');
    const [area, id, sub, target] = pieces;
    if (area === 'chat') {
      if (!id) return { kind: 'path', path: '/' };
      if (sub === 'thread' && target) return { kind: 'path', path: `/chat/${id}/thread/${target}` };
      if (sub === 'message' && target) return { kind: 'path', path: `/chat/${id}`, params: { messageId: target } };
      if (!sub) return { kind: 'path', path: `/chat/${id}` };
    }
    if (area === 'pages') return { kind: 'path', path: id ? `/pages/${id}` : '/pages' };
    if (area === 'records') {
      if (sub) return { kind: 'path', path: `/record/${sub}` };
      if (id) return { kind: 'database', key: id };
      return { kind: 'path', path: '/databases' };
    }
    if (area === 'trash' || area === 'archive') return { kind: 'path', path: '/settings/archive' };
    if (area === 'settings' || area === 'customize') {
      const section = id === 'profile' ? 'preferences' : id === 'trash' ? 'archive' : id;
      return { kind: 'path', path: section ? `/settings/${section}` : '/settings', ...(sub ? { params: { itemId: sub } } : {}) };
    }
    throw new Error('This screen is not available on mobile.');
  }
  if (!/^(https?:|mailto:|tel:)/i.test(href)) throw new Error('This link type is not supported.');
  const url = new URL(href);
  if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.hostname) throw new Error('This link is not valid.');
  return { kind: 'external', url: href };
}
