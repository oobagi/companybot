import { useState } from 'react';
import { ChoicePicker, EditorSheet } from './EditorSheet';
import { ListRow } from './ListRow';
import { useConfirm } from './useConfirm';

const periodLabel = (value: string) => new Date(`${value}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Calendar months, not timestamps: selecting a period must not shift with the device's zone. */
export function MonthPicker({ value, onChange }: { value: string; onChange: (month: string) => void }) {
  const [open, setOpen] = useState(false);
  return <><ListRow title="Period" value={periodLabel(value)} disclosure onPress={() => setOpen(true)} />
    {open && <PeriodEditor value={value} onChange={onChange} onClose={() => setOpen(false)} />}
  </>;
}

function PeriodEditor({ value, onChange, onClose }: { value: string; onChange: (month: string) => void; onClose: () => void }) {
  const [initial] = useState(value);
  const [year, setYear] = useState(() => value.split('-')[0]);
  const [month, setMonth] = useState(() => value.split('-')[1]);
  const { confirm, dialog } = useConfirm();
  const draft = `${year}-${month}`;
  const dirty = draft !== initial;
  const months = Array.from({ length: 12 }, (_, index) => ({
    value: String(index + 1).padStart(2, '0'),
    label: new Date(2000, index, 1).toLocaleDateString(undefined, { month: 'long' }),
  }));
  const lastYear = Math.max(new Date().getFullYear(), Number(initial.split('-')[0]));
  const years = Array.from({ length: lastYear - 1970 + 1 }, (_, index) => {
    const label = String(lastYear - index);
    return { value: label, label };
  });
  const close = async () => {
    if (!dirty || await confirm({ title: 'Discard period changes?', body: 'The current usage period will stay selected.', action: 'Discard', danger: true })) onClose();
  };
  return <EditorSheet title="Usage period" size="content" dismissible={!dirty} onClose={() => void close()} submit={{ onPress: () => { onChange(draft); onClose(); } }}>
    {dialog}
    <ChoicePicker label="Month" value={month} options={months} onChange={next => { if (typeof next === 'string') setMonth(next); }} />
    <ChoicePicker label="Year" value={year} options={years} onChange={next => { if (typeof next === 'string') setYear(next); }} />
  </EditorSheet>;
}
