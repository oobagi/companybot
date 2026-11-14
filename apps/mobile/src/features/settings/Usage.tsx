import { useState } from 'react';
import { formatUsd, monthLabel, usageKindLabels, usageMonth, type UsageKind } from '@companybot/core/usage';
import { MonthPicker } from '@/components/ui/MonthPicker';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';
import { EmptyState, ListRow, Loading, Screen, Section, Stack, Text } from '@/components/ui';

export default function Usage() {
  const [month, setMonth] = useState(() => usageMonth(Date.now()));
  const report = useQuery(api.usage.report, { month });
  return <Screen scroll><Stack gap="xl" style={{ flexGrow: 1 }}>
    <MonthPicker value={month} onChange={setMonth} />
    {report ? <>
      <Stack gap="xs">
        <Text variant="supporting" tone="muted">{report.scope === 'workspace' ? 'Workspace total' : 'Your usage'} · {monthLabel(report.month)}</Text>
        <Text variant="title">{formatUsd(report.total)}</Text>
      </Stack>
      {report.total === 0 ? <EmptyState title="No usage yet" description={`Nothing has been spent in ${monthLabel(month)}.`} /> : <>
        {report.truncated && <Text variant="supporting" tone="muted">Breakdown shows the top {report.personCount.toLocaleString()} people.</Text>}
        <Breakdown title="By agent" lines={report.byAgent.map(a => [a.id ?? 'other', a.name, a.costUsd])} />
        <Breakdown title="By person" lines={report.byPerson.map(p => [p.id ?? 'other', p.name, p.costUsd])} />
        <Breakdown title="By service" lines={report.byKind.map(k => [k.kind, usageKindLabels[k.kind as UsageKind] ?? k.kind, k.costUsd])} />
        <Breakdown title="By model" lines={report.byModel.map(m => [m.model, m.name, m.costUsd])} />
      </>}
    </> : <Loading />}
  </Stack></Screen>;
}

function Breakdown({ title, lines }: { title: string; lines: [string, string, number][] }) {
  if (!lines.length) return null;
  return <Section title={title}><Stack gap="none">{lines.map(([id, name, cost]) => <ListRow key={id} title={name} value={formatUsd(cost)} />)}</Stack></Section>;
}
