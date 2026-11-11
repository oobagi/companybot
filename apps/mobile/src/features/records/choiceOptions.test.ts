import { expect, it } from 'vitest';
import { choiceOptionsForSave } from './choiceOptions';

it('keeps the pending option on save while preserving existing option identities and retirement', () => {
  const options = Object.freeze([
    Object.freeze({ id: 'open', label: ' Open ' }),
    Object.freeze({ id: 'old', label: 'Old', retired: true }),
  ]);
  expect(choiceOptionsForSave('Status', options, ' Closed ')).toEqual([{ id: 'open', label: 'Open' }, { label: 'Closed' }]);
  expect(options[0].label).toBe(' Open ');
});

it('saves the same options whether the final option was added explicitly or left in the input', () => {
  const pending = choiceOptionsForSave('Status', [], 'Open');
  const added = choiceOptionsForSave('Status', [{ id: '', label: 'Open' }], '');
  expect(pending).toEqual(added);
  expect(choiceOptionsForSave('Status', [{ id: 'open', label: 'Open' }], '   ')).toEqual([{ id: 'open', label: 'Open' }]);
});

it('rejects invalid pending options without changing the draft', () => {
  const options = [{ id: 'open', label: 'Open' }];
  expect(() => choiceOptionsForSave('Status', options, ' open ')).toThrow('same name');
  expect(options).toEqual([{ id: 'open', label: 'Open' }]);
  expect(() => choiceOptionsForSave('Status', [{ id: '', label: '  ' }], 'Closed')).toThrow('Every option needs a name');
  expect(() => choiceOptionsForSave('Status', [], '')).toThrow('at least one option');
});
