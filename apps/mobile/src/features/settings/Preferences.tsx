import { useState } from 'react';
import { Platform } from 'react-native';
import { Stack as NavigationStack } from 'expo-router';
import { useAuthActions } from '@convex-dev/auth/react';
import type { FunctionReturnType } from 'convex/server';
import { isValidTimeZone } from '@companybot/core/automations';
import { useNotifications } from '@/lib/notifications/NotificationsProvider';
import { NotificationsControl } from './NotificationsControl';
import { ImageControl } from './customize/ImageControl';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { Avatar, Button, Card, ChoicePicker, EditorSheet, ErrorState, Field, ListRow, Loading, Screen, Section, Stack, Text } from '@/components/ui';

type ProfilePreferences = FunctionReturnType<typeof api.preferences.get>;
const conversationOptions = [{ value: 'all', label: 'Direct messages and mentions' }, { value: 'mentions', label: 'Mentions only' }, { value: 'off', label: 'Off' }];
const editablePreferences = (prefs: ProfilePreferences) => ({ name: prefs.displayName, zone: prefs.timeZone ?? '', notify: prefs.notify });

export default function Preferences() {
  const prefs = useQuery(api.preferences.get);
  const me = useQuery(api.workspace.me);
  const erase = useMutation(api.workspace.eraseAccount);
  const { signOut } = useAuthActions();
  const { beforeSignOut } = useNotifications();
  const task = useTask();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  if (!prefs) return <Loading />;
  const name = prefs.displayName || me?.email || 'Your account';
  return <>
    {Platform.OS !== 'web' && <NavigationStack.Toolbar placement="right"><NavigationStack.Toolbar.Button onPress={() => setEditing(true)}>Edit</NavigationStack.Toolbar.Button></NavigationStack.Toolbar>}
    <Screen scroll><Stack gap="xl">
      <Stack horizontal><Avatar name={name} image={prefs.image} size="lg" /><Stack gap="xs" style={{ flex: 1 }}><Text variant="heading">{name}</Text>{me?.email && prefs.displayName && <Text tone="muted">{me.email}</Text>}</Stack></Stack>
      {Platform.OS === 'web' && <Button label="Edit profile" variant="secondary" onPress={() => setEditing(true)} />}
      <Section title="Profile"><Card style={{ padding: 0, gap: 0 }}><ListRow title="Display name" value={prefs.displayName || 'Not set'} /><ListRow title="Time zone" value={prefs.timeZone || `Automatic · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`} /></Card></Section>
      <Section title="Notifications"><Card style={{ padding: 0, gap: 0 }}><ListRow title="Conversations" value={conversationOptions.find(o => o.value === prefs.notify)?.label} /><NotificationsControl /></Card></Section>
      <Section title="Account"><Button label="Erase account" variant="ghost" onPress={() => { task.clear(); setConfirmation(''); setDeleting(true); }} /></Section>
    </Stack>
      {editing && <ProfileEditor initial={prefs} onClose={() => setEditing(false)} />}
      {deleting && <EditorSheet title="Erase your account?" onClose={() => setDeleting(false)} busy={task.busy}><Text>Your personal data will be erased. Team history stays under a former member. This cannot be undone. Type {me?.email} to confirm.</Text><Field label="Your email address" value={confirmation} onChangeText={setConfirmation} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" editable={!task.busy} />{task.error && <ErrorState message={task.error} />}<Button label="Erase account permanently" variant="danger" loading={task.busy} disabled={!me?.email || confirmation !== me.email} onPress={() => void task.run(async () => { await beforeSignOut(); await erase(); await signOut(); })} /></EditorSheet>}
    </Screen>
  </>;
}

function ProfileEditor({ initial, onClose }: { initial: ProfilePreferences; onClose: () => void }) {
  const [baseline] = useState(() => editablePreferences(initial));
  const [draft, setDraft] = useState(baseline);
  const current = useQuery(api.preferences.get);
  const update = useMutation(api.preferences.update);
  const task = useTask();
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const conflict = !!current && JSON.stringify(editablePreferences(current)) !== JSON.stringify(baseline);
  const guard = useDraftGuard({ dirty, busy: task.busy, onClose });
  const nameError = !draft.name.trim() ? 'Enter a display name.' : draft.name.trim().length > 60 ? 'Use 60 characters or fewer.' : undefined;
  const zoneError = draft.zone.trim() && !isValidTimeZone(draft.zone.trim()) ? 'Enter a valid time zone, such as America/Los_Angeles.' : undefined;
  return <EditorSheet title="Edit profile" onClose={() => void guard.close()} dismissible={guard.dismissible} busy={task.busy}>
    {guard.dialog}
    {conflict && <Text tone="danger" accessibilityRole="alert">Your preferences changed on another device. Close and reopen the editor to review them.</Text>}
    <Section title="Profile">
      <Field label="Display name" value={draft.name} onChangeText={name => setDraft({ ...draft, name })} maxLength={60} error={nameError} editable={!task.busy} textContentType="name" autoComplete="name" />
      <Field label="Time zone" value={draft.zone} onChangeText={zone => setDraft({ ...draft, zone })} placeholder="Automatic" hint="Leave blank to follow this device." error={zoneError || undefined} editable={!task.busy} autoCapitalize="none" autoCorrect={false} />
    </Section>
    <Section title="Notifications" description="Your conversation preference applies on all your devices.">
      <ChoicePicker label="Conversations" value={draft.notify} options={conversationOptions} disabled={task.busy} onChange={notify => { if (notify === 'all' || notify === 'mentions' || notify === 'off') setDraft({ ...draft, notify }); }} />
    </Section>
    {task.error && <ErrorState message={task.error} />}
    <Button label="Save changes" loading={task.busy} disabled={!dirty || conflict || !!nameError || !!zoneError} onPress={() => void task.run(async () => {
      if (nameError || zoneError || conflict) return;
      // Preferences have no version contract. Send only changed fields to avoid overwriting unrelated updates.
      await update({ ...(draft.name !== baseline.name && { displayName: draft.name.trim() }), ...(draft.zone !== baseline.zone && { timeZone: draft.zone.trim() || null }), ...(draft.notify !== baseline.notify && { notify: draft.notify }), deviceTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      onClose();
    })} />
    <Section title="Profile picture" description="Picture changes save immediately."><ImageControl of="me" name={initial.displayName || 'You'} image={current ? current.image : initial.image} disabled={task.busy} /></Section>
  </EditorSheet>;
}
