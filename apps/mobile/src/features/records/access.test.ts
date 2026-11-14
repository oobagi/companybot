import { describe, expect, it } from 'vitest';
import type { Access } from '@companybot/core/permissions';
import { recordCapabilities } from './access';

describe('record access', () => {
  const author: Access = { owner: false, roles: ['writer'], permissions: ['records.edit', 'pages.edit'] };
  it('does not let workspace permissions bypass view-only database access', () => {
    expect(recordCapabilities(author, { canEdit: false, archived: false })).toEqual({ edit: false, notes: false, undo: false });
    expect(recordCapabilities({ ...author, owner: true }, { canEdit: false, archived: false })).toEqual({ edit: false, notes: false, undo: false });
  });
  it('handles custom roles independently for records and notes and denies loading access', () => {
    const record = { canEdit: true, archived: false };
    expect(recordCapabilities({ ...author, permissions: ['pages.edit'] }, record)).toEqual({ edit: false, notes: true, undo: false });
    expect(recordCapabilities({ ...author, permissions: ['records.edit'] }, record)).toEqual({ edit: true, notes: false, undo: true });
    expect(recordCapabilities(undefined, record)).toEqual({ edit: false, notes: false, undo: false });
  });
  it('keeps archived content read-only while allowing authorized history undo', () => {
    expect(recordCapabilities(author, { canEdit: true, archived: true })).toEqual({ edit: false, notes: false, undo: true });
  });
});
