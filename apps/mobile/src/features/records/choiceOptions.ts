import { fieldConfigError, normalizeFieldConfig, type ChoiceOption } from '@companybot/core/records';

/** Saving includes the last typed option even when Add option was not pressed. */
export function choiceOptionsForSave(label: string, options: readonly ChoiceOption[], pending: string) {
  const choices = options.filter(option => !option.retired).map(option => ({ ...(option.id ? { id: option.id } : {}), label: option.label.trim() }));
  if (pending.trim()) choices.push({ label: pending.trim() });
  const error = fieldConfigError(normalizeFieldConfig({ label, kind: 'choice', options: choices }));
  if (error) throw new Error(error);
  return choices;
}
