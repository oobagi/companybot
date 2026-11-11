import { expect, it } from 'vitest';
import { valueText } from './model';

it('renders cleared arrays and inaccessible references as explicit values', () => {
  expect(valueText(undefined, [])).toBe('Empty');
  expect(valueText({ key: 'related', label: 'Related', kind: 'link', linkType: 'deals' }, 'record-1', { 'record-1': { name: '', locked: true } })).toBe('Locked record');
  expect(valueText(undefined, 'record-1', { 'record-1': { name: '', locked: true } })).toBe('Locked record');
});
