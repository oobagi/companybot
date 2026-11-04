import { minorDigits, minorToDecimal, normalizeValue, type Field } from '@companybot/core/records';
import type { ViewConfig } from './model';

export type Condition = ViewConfig['filters'][number];
export type FilterDraft = { field: string; op: 'eq' | 'in' | 'range' | 'empty' | 'notEmpty'; value: string; values: string[]; lower: string; lowerOp: 'gt' | 'gte'; upper: string; upperOp: 'lt' | 'lte' };
export function filterValueInput(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'minor' in value && typeof value.minor === 'number' && 'currency' in value && typeof value.currency === 'string') return `${value.currency} ${minorToDecimal(value.minor, minorDigits(value.currency))}`;
  return String(value);
}
export function draftFilter(field: string, condition?: Condition): FilterDraft {
  return { field: condition?.field ?? field, op: condition?.empty !== undefined ? condition.empty ? 'empty' : 'notEmpty' : condition?.in ? 'in' : condition && ['gt', 'gte', 'lt', 'lte'].some(key => key in condition) ? 'range' : 'eq', value: filterValueInput(condition?.eq), values: condition?.in?.map(filterValueInput) ?? [], lower: filterValueInput(condition?.gt ?? condition?.gte), lowerOp: condition?.gt !== undefined ? 'gt' : 'gte', upper: filterValueInput(condition?.lt ?? condition?.lte), upperOp: condition?.lt !== undefined ? 'lt' : 'lte' };
}

/** Validate locally but keep money in input units: the backend performs its own normalization. */
export function buildFilter(field: Field, draft: FilterDraft, currency: string): Condition {
  if (draft.op === 'empty' || draft.op === 'notEmpty') return { field: field.key, empty: draft.op === 'empty' };
  const validate = (input: string) => {
    if (!input.trim()) throw new Error('Choose a filter value.');
    let normalized: ReturnType<typeof normalizeValue>;
    try { normalized = normalizeValue({ ...field, multiple: false }, field.kind === 'checkbox' ? input === 'true' : input, 'filter', currency); }
    catch { throw new Error(`Enter a valid ${field.label.toLowerCase()} value.`); }
    if ('error' in normalized) throw new Error(normalized.error);
    return field.kind === 'currency' ? input.trim() : normalized.value;
  };
  if (draft.op === 'in') {
    if (!['choice', 'user', 'link'].includes(field.kind)) throw new Error('Any-of filters apply to choices, people and linked records.');
    if (!draft.values.length || draft.values.length > 50) throw new Error('Choose between 1 and 50 values.');
    return { field: field.key, in: draft.values.map(validate) };
  }
  if (draft.op === 'range') {
    if (field.multiple || !['number', 'currency', 'date'].includes(field.kind)) throw new Error('Ranges apply to single amounts, numbers and dates.');
    if (!draft.lower.trim() && !draft.upper.trim()) throw new Error('Enter at least one range bound.');
    const lower = draft.lower.trim() ? validate(draft.lower) : undefined;
    const upper = draft.upper.trim() ? validate(draft.upper) : undefined;
    if (field.kind === 'currency' && lower !== undefined && upper !== undefined) {
      const low = normalizeValue(field, lower, 'filter', currency);
      const high = normalizeValue(field, upper, 'filter', currency);
      if ('value' in low && 'value' in high && low.value && high.value && typeof low.value === 'object' && !Array.isArray(low.value) && typeof high.value === 'object' && !Array.isArray(high.value) && low.value.currency !== high.value.currency) throw new Error('Compare amounts in one currency.');
    }
    return { field: field.key, ...(lower !== undefined ? { [draft.lowerOp]: lower } : {}), ...(upper !== undefined ? { [draft.upperOp]: upper } : {}) };
  }
  const value = validate(draft.value);
  // Unchecked is not indexed; asking for equality with null is not a valid list condition.
  return field.kind === 'checkbox' ? { field: field.key, empty: value !== true } : { field: field.key, eq: value };
}

export function replaceFilter(filters: Condition[], next: Condition, index?: number): Condition[] {
  if (index === undefined) { if (filters.length >= 10) throw new Error('Use up to 10 filters.'); return [...filters, next]; }
  if (index < 0 || index >= filters.length) throw new Error('This filter no longer exists.');
  return filters.map((condition, at) => at === index ? next : condition);
}
/** A local draft keeps its original base even if a subscription brings a newer server version. */
export const viewIsStale = (baseVersion: number | undefined, latestVersion: number | undefined) => baseVersion !== latestVersion;
