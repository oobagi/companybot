import { useState } from 'react';
import { formatUsd, usageMonth } from '@companybot/core/usage';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';
import { Button, Card, Field, ListRow, Loading, Screen, Section, Stack, Text } from '@/components/ui';

export default function Usage() {
  const [month, setMonth] = useState(() => usageMonth(Date.now()));
  const [draft, setDraft] = useState(month);
  const report = useQuery(api.usage.report, { month });
  return <Screen scroll keyboard><Stack gap="xl" style={{ flexGrow: 1 }}><Card><Field label="Month (YYYY-MM)" value={draft} onChangeText={setDraft} autoCapitalize="none" maxLength={7} /><Button label="Show month" variant="secondary" disabled={!/^\d{4}-(0[1-9]|1[0-2])$/.test(draft)} onPress={() => setMonth(draft)} /></Card>
  {report ? <><Card><Text tone="muted">{report.scope === 'workspace' ? 'Workspace total' : 'Your usage'} · {report.month}</Text><Text variant="title">{formatUsd(report.total)}</Text></Card><Section title="By agent"><Card>{report.byAgent.map(a => <ListRow key={a.id ?? 'other'} title={a.name} trailing={<Text>{formatUsd(a.costUsd)}</Text>} />)}{!report.byAgent.length && <Text tone="muted">No AI usage this month.</Text>}</Card></Section>{report.byPerson.length > 0 && <Section title="By person"><Card>{report.byPerson.map(p => <ListRow key={p.id ?? 'other'} title={p.name} trailing={<Text>{formatUsd(p.costUsd)}</Text>} />)}</Card></Section>}<Section title="By model"><Card>{report.byModel.map(m => <ListRow key={m.model} title={m.name} trailing={<Text>{formatUsd(m.costUsd)}</Text>} />)}</Card></Section><Section title="By service"><Card>{report.byKind.map(k => <ListRow key={k.kind} title={k.kind} trailing={<Text>{formatUsd(k.costUsd)}</Text>} />)}</Card></Section></> : <Loading />}</Stack></Screen>;
}
