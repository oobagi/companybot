import { useState } from 'react';
import { useAuthActions } from '@convex-dev/auth/react';
import { useConvex } from 'convex/react';
import { isLocalBackend } from '@companybot/core/local-auth';
import { api } from '@/lib/api';
import { convexUrl } from '@/lib/config';
import { useTask } from '@/lib/useTask';
import { Avatar, Button, Card, ErrorState, Field, Screen, Stack, Text } from '@/components/ui';

export default function SignIn() {
  const { signIn } = useAuthActions();
  const convex = useConvex();
  const task = useTask();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string>();
  const [code, setCode] = useState('');
  const submit = () => task.run(async () => {
    if (sentTo) {
      if (!/^\d{6}$/.test(code.trim())) throw new Error('Enter the six-digit code from your email.');
      await signIn('email-code', { email: sentTo, code: code.trim() });
      return;
    }
    const to = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(to)) throw new Error('Enter your full email address.');
    await signIn('email-code', { email: to });
    if (convexUrl && isLocalBackend(convexUrl)) {
      const localCode = await convex.query(api.auth.localCode, { email: to });
      if (localCode) { await signIn('email-code', { email: to, code: localCode }); return; }
    }
    setSentTo(to);
  });
  return <Screen scroll keyboard edges={['top', 'left', 'right', 'bottom']} contentStyle={{ justifyContent: 'center' }}>
    <Stack gap="xxl">
      <Stack><Avatar name="Companybot" agent size="lg" /><Text variant="title">{sentTo ? 'Check your email' : 'Your team, together.'}</Text><Text tone="muted">{sentTo ? `We sent a six-digit code to ${sentTo}.` : 'Chat, work, and build with your team and your agents.'}</Text></Stack>
      <Card>
        <Text variant="heading">{sentTo ? 'Enter your code' : 'Sign in to Companybot'}</Text>
        {sentTo ? <Field label="Email code" value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={6} onSubmitEditing={() => void submit()} /> : <Field label="Email address" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="emailAddress" placeholder="you@company.com" onSubmitEditing={() => void submit()} />}
        {task.error && <ErrorState message={task.error} />}
        <Button label={sentTo ? 'Sign in' : 'Email me a code'} loading={task.busy} onPress={() => void submit()} />
        {sentTo && <><Button label="Send another code" variant="secondary" disabled={task.busy} onPress={() => void task.run(async () => { await signIn('email-code', { email: sentTo }); })} /><Button label="Use a different email" variant="ghost" disabled={task.busy} onPress={() => { setSentTo(undefined); setCode(''); task.clear(); }} /></>}
      </Card>
    </Stack>
  </Screen>;
}
