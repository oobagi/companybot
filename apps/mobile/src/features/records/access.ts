import { can, type Access } from '@companybot/core/permissions';

/** Place access and workspace switches are independent. Even owners use the server's place result. */
export function recordCapabilities(access: Access | null | undefined, record: { canEdit: boolean; archived: boolean }) {
  const place = record.canEdit && !record.archived;
  return {
    edit: !!access && place && can(access, 'records.edit'),
    notes: !!access && place && can(access, 'pages.edit'),
    undo: !!access && record.canEdit && can(access, 'records.edit'),
  };
}
