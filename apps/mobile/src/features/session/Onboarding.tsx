import { useState } from 'react';
import { useAuthActions } from '@convex-dev/auth/react';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { useNotifications } from '@/lib/notifications/NotificationsProvider';
import { api } from '@/lib/api';
import { useMutation } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { Button, Card, ErrorState, Field, Screen, Stack, Text } from '@/components/ui';

export function Onboarding({ onDone }: { onDone: (id: Id<'workspaces'>) => void }) {
  const create = useMutation(api.workspace.setUp);
  const { signOut } = useAuthActions();
  const { beforeSignOut } = useNotifications();
  const task = useTask();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [invites, setInvites] = useState('');
  const submit = () => task.run(async () => {
    if (step === 0 && !name.trim()) throw new Error('Enter your name.');
    if (step === 1 && !company.trim()) throw new Error('Enter your company name.');
    if (step < 2) { setStep(step + 1); return; }
    const emails = [...new Set(invites.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean))];
    const bad = emails.find(e => !/^\S+@\S+\.\S+$/.test(e));
    if (bad) throw new Error(`Check this email address: ${bad}`);
    onDone(await create({ displayName: name.trim(), name: company.trim(), currency: currency.trim().toUpperCase(), invites: emails }));
  });
  return <Screen scroll keyboard edges={['top', 'left', 'right', 'bottom']} contentStyle={{ justifyContent: 'center' }}><Stack gap="xl">
    <Text tone="muted" variant="caption">Step {step + 1} of 3</Text><Text variant="title">{['First, your name', 'Name your company', 'Bring your team'][step]}</Text>
    <Card>{step === 0 ? <Field label="Your name" value={name} onChangeText={setName} autoComplete="name" maxLength={60} /> : step === 1 ? <><Field label="Company name" value={company} onChangeText={setCompany} /><Field label="Currency code" hint="For example USD, EUR or GBP. You can change this later." value={currency} onChangeText={setCurrency} autoCapitalize="characters" maxLength={3} /></> : <Field label="Team email addresses" hint="Separate addresses with commas. You can invite people later." value={invites} onChangeText={setInvites} autoCapitalize="none" keyboardType="email-address" multiline />}
    {task.error && <ErrorState message={task.error} />}<Button label={step === 2 ? 'Create workspace' : 'Continue'} loading={task.busy} onPress={() => void submit()} />{step > 0 && <Button label="Back" variant="ghost" disabled={task.busy} onPress={() => { task.clear(); setStep(step - 1); }} />}</Card>
    <Button label="Sign out" variant="ghost" disabled={task.busy} onPress={() => void task.run(async () => { await beforeSignOut(); await signOut(); })} />
  </Stack></Screen>;
}
