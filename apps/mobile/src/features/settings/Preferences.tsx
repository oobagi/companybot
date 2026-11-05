import { EditToolbarButton } from '@/components/navigation/EditToolbarButton';
import { useState } from 'react';
import { useAuthActions } from '@convex-dev/auth/react';
import type { FunctionReturnType } from 'convex/server';
import { isValidTimeZone } from '@companybot/core/automations';
import { useNotifications } from '@/lib/notifications/NotificationsProvider';
import { deviceNotificationStatus, NotificationsControl } from './NotificationsControl';
import { ImageControl } from './customize/ImageControl';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { Avatar, Button, ChoicePicker, EditorSheet, ErrorState, Field, GroupedList, Loading, Screen, Section, Text } from '@/components/ui';

type ProfilePreferences = FunctionReturnType<typeof api.preferences.get>;
const conversationOptions = [{ value: 'all', label: 'Direct messages and mentions' }, { value: 'mentions', label: 'Mentions only' }, { value: 'off', label: 'Off' }];
const editablePreferences = (prefs: ProfilePreferences) => ({ name: prefs.displayName, zone: prefs.timeZone ?? '', notify: prefs.notify });

export default function Preferences() {
  const prefs = useQuery(api.preferences.get);
  const me = useQuery(api.workspace.me);
  const erase = useMutation(api.workspace.eraseAccount);
  const { signOut } = useAuthActions();
  const notifications = useNotifications();
  const { beforeSignOut } = notifications;
  const task = useTask();
  const [editing, setEditing] = useState(false);
  const [deviceNotifications, setDeviceNotifications] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  if (!prefs) return <Screen><Loading /></Screen>;
  const name = prefs.displayName || me?.email || 'Your account';
  const edit = () => setEditing(true);
  return <>
    <EditToolbarButton label="Edit profile" onPress={edit} disabled={task.busy} />
    <Screen nativeScroll padded={false}>
      <GroupedList sections={[
        { id: 'profile', title: 'Profile', rows: [
          { id: 'identity', title: name, subtitle: me?.email && prefs.displayName ? me.email : undefined, leading: <Avatar name={name} image={prefs.image} size="lg" />, onPress: edit, disabled: task.busy, accessibilityHint: 'Edit your profile and preferences' },
          { id: 'name', title: 'Display name', value: prefs.displayName || 'Not set', onPress: edit, disabled: task.busy },
          { id: 'zone', title: 'Time zone', value: prefs.timeZone || `Automatic · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`, onPress: edit, disabled: task.busy },
        ] },
        { id: 'notifications', title: 'Notifications', rows: [
          { id: 'conversations', title: 'Conversations', value: conversationOptions.find(o => o.value === prefs.notify)?.label, onPress: edit, disabled: task.busy },
          { id: 'device', title: 'On this device', value: deviceNotificationStatus(notifications), onPress: () => setDeviceNotifications(true), disabled: task.busy },
        ] },
        { id: 'account', title: 'Account', rows: [{ id: 'erase', title: 'Erase account', destructive: true, disabled: task.busy, onPress: () => { task.clear(); setConfirmation(''); setDeleting(true); } }] },
      ]} />
      {deviceNotifications && <NotificationsControl onClose={() => setDeviceNotifications(false)} />}
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
  const [pictureBusy, setPictureBusy] = useState(false);
  const busy = task.busy || pictureBusy;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const conflict = !!current && JSON.stringify(editablePreferences(current)) !== JSON.stringify(baseline);
  const guard = useDraftGuard({ dirty, busy, onClose });
  const nameError = draft.name.trim().length > 60 ? 'Use 60 characters or fewer.' : undefined;
  const zoneError = draft.zone.trim() && !isValidTimeZone(draft.zone.trim()) ? 'Enter a valid time zone, such as America/Los_Angeles.' : undefined;
  return <EditorSheet title="Edit profile" onClose={() => void guard.close()} dismissible={guard.dismissible} busy={busy}>
    {guard.dialog}
    {conflict && <Text tone="danger" accessibilityRole="alert">Your preferences changed on another device. Close and reopen the editor to review them.</Text>}
    <Section title="Profile">
      <Field label="Display name" value={draft.name} onChangeText={name => setDraft({ ...draft, name })} maxLength={60} error={nameError} editable={!busy} textContentType="name" autoComplete="name" />
      <Field label="Time zone" value={draft.zone} onChangeText={zone => setDraft({ ...draft, zone })} placeholder="Automatic" hint="Leave blank to follow this device." error={zoneError || undefined} editable={!busy} autoCapitalize="none" autoCorrect={false} />
    </Section>
    <Section title="Notifications" description="Your conversation preference applies on all your devices.">
      <ChoicePicker label="Conversations" value={draft.notify} options={conversationOptions} disabled={busy} onChange={notify => { if (notify === 'all' || notify === 'mentions' || notify === 'off') setDraft({ ...draft, notify }); }} />
    </Section>
    {task.error && <ErrorState message={task.error} />}
    <Button label="Save changes" loading={task.busy} disabled={pictureBusy || !dirty || conflict || !!nameError || !!zoneError} onPress={() => void task.run(async () => {
      if (pictureBusy || nameError || zoneError || conflict) return;
      // Preferences have no version contract. Send only changed fields to avoid overwriting unrelated updates.
      await update({ ...(draft.name !== baseline.name && { displayName: draft.name.trim() }), ...(draft.zone !== baseline.zone && { timeZone: draft.zone.trim() || null }), ...(draft.notify !== baseline.notify && { notify: draft.notify }), deviceTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      guard.complete();
      onClose();
    })} />
    <Section title="Profile picture" description="Picture changes save immediately."><ImageControl of="me" name={initial.displayName || 'You'} image={current ? current.image : initial.image} disabled={task.busy} onBusyChange={setPictureBusy} /></Section>
  </EditorSheet>;
}
