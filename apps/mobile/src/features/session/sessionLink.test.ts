import { expect, it } from 'vitest';
import { pageHref } from '@companybot/core/page-links';
import { sessionLink } from './sessionLink';

it('retains supported app paths and normalizes canonical saved page links', () => {
  expect(sessionLink('companybot://databases')).toBe('/databases');
  expect(sessionLink('companybot:///settings/preferences')).toBe('/settings/preferences');
  expect(sessionLink(pageHref('page123'))).toBe('/pages/page123');
  expect(sessionLink('companybot://pages/page123')).toBe('/pages/page123');
  expect(sessionLink('companybot://record/record123')).toBe('/record/record123');
  expect(sessionLink('companybot://database/type123')).toBe('/database/type123');
});

it('preserves supported target parameters without accepting navigation-control parameters', () => {
  expect(sessionLink('companybot://chat/chat123/thread/thread123?messageId=msg123&screen=sign-in&redirect=https://evil.test')).toBe('/chat/chat123/thread/thread123?messageId=msg123');
  expect(sessionLink('companybot://settings/agents?itemId=agent123')).toBe('/settings/agents?itemId=agent123');
  expect(sessionLink('companybot://settings/permissions?connectorId=connector123')).toBe('/settings/permissions?connectorId=connector123');
  expect(sessionLink('companybot://chat/chat123?messageId=%2Fother')).toBe('/chat/chat123');
});

it('rejects external, malformed, auth and unsupported destinations', () => {
  for (const url of [null, 'https://companybot.com/pages/page123', 'javascript:alert(1)', 'file:///pages/page123', '/pages/page123', 'companybot://sign-in', 'companybot://unknown', 'companybot://settings/unknown', 'companybot://user:pass@pages/page123', 'companybot://pages:3000/page123', 'companybot://pages/page123#fragment', 'companybot://pages/%2Fpage123', 'companybot://pages/page123/extra']) {
    expect(sessionLink(url), String(url)).toBeNull();
  }
});
