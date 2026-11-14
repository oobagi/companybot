import { expectTypeOf, it } from 'vitest';
import type { SettingsListProps, SettingsRowData } from './SettingsList';

it('keeps toggles controlled and prevents a second nested press action', () => {
  type Toggle = Extract<SettingsRowData, { kind: 'toggle' }>;
  expectTypeOf<Toggle['value']>().toEqualTypeOf<boolean>();
  expectTypeOf<Toggle['onValueChange']>().toEqualTypeOf<(value: boolean) => void>();
  expectTypeOf<Toggle['onPress']>().toEqualTypeOf<undefined>();
  expectTypeOf<Toggle['destructive']>().toEqualTypeOf<undefined>();
});

it('accepts readonly section data without requiring actions on informational rows', () => {
  const props = { sections: [{ id: 'details', rows: [{ id: 'name', title: 'Name', value: 'Example' }] }] } as const;
  expectTypeOf(props).toExtend<SettingsListProps>();
  type ValueRow = Exclude<SettingsRowData, { kind: 'toggle' }>;
  expectTypeOf<ValueRow['onValueChange']>().toEqualTypeOf<undefined>();
});
