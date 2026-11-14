import { expect, it } from 'vitest';
import { normalizeDocumentLink } from './documentLink';

it('resolves bare website addresses and preserves explicit supported destinations', () => {
  expect(normalizeDocumentLink(' example.com/path?q=1#part ')).toBe('https://example.com/path?q=1#part');
  expect(normalizeDocumentLink('example.com:8443')).toBe('https://example.com:8443/');
  for (const href of ['https://example.com', 'http://localhost:8081/path', 'mailto:team@example.com', 'tel:+15551234567', 'companybot://page/page1', 'companybot://record/record1']) expect(normalizeDocumentLink(href)).toBe(href);
});

it.each(['', 'ftp://example.com', 'sms:+15551234567', 'javascript:alert(1)', 'companybot://unknown/id1', 'companybot://page/id1?query=x', '/pages/id1', '../example.com', '//example.com', '#section', 'document', 'team@example.com', 'https://', 'mailto:', 'tel:', 'https:\\example.com', 'https://exa\nmple.com'])('rejects an unsupported or unresolved address: %s', href => {
  expect(normalizeDocumentLink(href)).toBeNull();
});
