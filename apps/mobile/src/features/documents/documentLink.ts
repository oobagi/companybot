import { linkedPageId, linkedRecordId } from '@companybot/core/page-links';

export const unsupportedDocumentLink = 'This link is not supported. Use a website address, email link (mailto:), phone link (tel:), or Companybot page or record link.';

/** Resolve new input and clicked legacy links without rewriting stored documents. */
export function normalizeDocumentLink(value: string): string | null {
  const href = value.trim();
  if (!href || /[\u0000-\u001f\u007f\\]/.test(href)) return null;
  if (linkedPageId(href) || linkedRecordId(href)) return href;
  try {
    if (/^(https?:|mailto:|tel:)/i.test(href)) {
      const parsed = new URL(href);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return /^https?:\/\//i.test(href) && !!parsed.hostname ? href : null;
      return parsed.pathname.trim() ? href : null;
    }
    // A host, optionally with a port/path, is resolvable without a document base URL.
    // Schemes, relative paths and email addresses are deliberately not inferred.
    if (!/^[^:/?#]+\.[^:/?#]+(?::\d+)?(?:[/?#]|$)/.test(href) || /^[./?#]/.test(href)) return null;
    const parsed = new URL(`https://${href}`);
    if (parsed.username || parsed.password || !parsed.hostname.includes('.')) return null;
    return parsed.href;
  } catch { return null; }
}
