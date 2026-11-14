import { EditToolbarButton } from '@/components/navigation/EditToolbarButton';
import { useState } from 'react';
import { Keyboard, View } from 'react-native';
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
import { Avatar, Button, ChoicePicker, EditorSheet, ErrorState, Field, SettingsList, Loading, Screen, Stack, Text } from '@/components/ui';

type ProfilePreferences = FunctionReturnType<typeof api.preferences.get>;
const conversationOptions = [{ value: 'all', label: 'Direct messages and mentions' }, { value: 'mentions', label: 'Mentions only' }, { value: 'off', label: 'Off' }];
const editablePreferences = (prefs: ProfilePreferences) => ({ name: prefs.displayName, zone: prefs.timeZone ?? '', notify: prefs.notify });

export default function Preferences() {
  const prefs = useQuery(api.preferences.get);
  const me = useQuery(api.workspace.me);
  const erase = useMutation(api.workspace.eraseAccount);
  const update = useMutation(api.preferences.update);
  const { signOut } = useAuthActions();
  const notifications = useNotifications();
  const { beforeSignOut } = notifications;
  const task = useTask();
  const [editing, setEditing] = useState(false);
  const [editingPicture, setEditingPicture] = useState(false);
  const [deviceNotifications, setDeviceNotifications] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  if (!prefs) return <Screen><Loading /></Screen>;
  const name = prefs.displayName || me?.email || 'Your account';
  const edit = () => setEditing(true);
  return <>
    <EditToolbarButton label="Edit profile" onPress={edit} disabled={task.busy} />
    <Screen nativeScroll padded={false}>
      {task.error && !deleting && <ErrorState message={task.error} />}
      <SettingsList sections={[
        { id: 'profile', title: 'Profile', rows: [
          { id: 'identity', title: name, subtitle: me?.email && prefs.displayName ? me.email : undefined, leading: <Avatar name={name} image={prefs.image} size="lg" />, onPress: edit, disabled: task.busy, accessibilityHint: 'Edit your profile and preferences' },
          { id: 'picture', title: 'Change profile picture', onPress: () => setEditingPicture(true), disabled: task.busy },
          { id: 'zone', title: 'Time zone', value: prefs.timeZone || `Automatic · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`, onPress: edit, disabled: task.busy },
        ] },
        { id: 'notifications', title: 'Notifications', rows: [
          { id: 'conversations', title: 'Conversations', value: conversationOptions.find(o => o.value === prefs.notify)?.label, onPress: edit, disabled: task.busy },
          { id: 'device', title: 'On this device', value: deviceNotificationStatus(notifications), onPress: () => setDeviceNotifications(true), disabled: task.busy },
        ] },
        { id: 'drive', title: 'Drive', rows: [
          { id: 'foldersFirst', title: 'Folders on top', subtitle: 'Show folders above pages and files', kind: 'toggle', value: prefs.foldersFirst, disabled: task.busy, onValueChange: on => void task.run(() => update({ foldersFirst: on })) },
        ] },
        { id: 'account', title: 'Account', rows: [{ id: 'erase', title: 'Erase account', destructive: true, disabled: task.busy, onPress: () => { task.clear(); setConfirmation(''); setDeleting(true); } }] },
      ]} />
      {deviceNotifications && <NotificationsControl onClose={() => setDeviceNotifications(false)} />}
      {editingPicture && <ProfilePictureEditor initial={prefs} onClose={() => setEditingPicture(false)} />}
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
  const busy = task.busy;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const conflict = !!current && JSON.stringify(editablePreferences(current)) !== JSON.stringify(baseline);
  const guard = useDraftGuard({ dirty, busy, onClose });
  const nameError = draft.name.trim().length > 60 ? 'Use 60 characters or fewer.' : undefined;
  const zoneError = draft.zone.trim() && !isValidTimeZone(draft.zone.trim()) ? 'Enter a valid time zone, such as America/Los_Angeles.' : undefined;
  const canSave = dirty && !conflict && !nameError && !zoneError;
  const save = () => {
    if (!canSave) return;
    void task.run(async () => {
      // Preferences have no version contract. Send only changed fields to avoid overwriting unrelated updates.
      await update({ ...(draft.name !== baseline.name && { displayName: draft.name.trim() }), ...(draft.zone !== baseline.zone && { timeZone: draft.zone.trim() || null }), ...(draft.notify !== baseline.notify && { notify: draft.notify }), deviceTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      Keyboard.dismiss();
      guard.complete();
      onClose();
    });
  };
  return <EditorSheet title="Edit profile" size="content" onClose={() => void guard.close()} dismissible={guard.dismissible} busy={busy} submit={{ onPress: save, disabled: !canSave }}>
    {guard.dialog}
    <View style={{ alignItems: 'center' }}><Avatar name={draft.name || 'You'} image={current ? current.image : initial.image} size="lg" /></View>
    {conflict && <Text tone="danger" accessibilityRole="alert">Your preferences changed on another device. Close and reopen the editor to review them.</Text>}
    <Field label="Display name" value={draft.name} onChangeText={name => setDraft({ ...draft, name })} maxLength={60} error={nameError} editable={!busy} textContentType="name" autoComplete="name" returnKeyType="done" onSubmitEditing={save} />
    <Field label="Time zone" value={draft.zone} onChangeText={zone => setDraft({ ...draft, zone })} placeholder="Automatic" hint="Leave blank to follow this device." error={zoneError || undefined} editable={!busy} autoCapitalize="none" autoCorrect={false} returnKeyType="done" onSubmitEditing={save} />
    <Stack gap="xs">
      <ChoicePicker label="Notifications" value={draft.notify} options={conversationOptions} disabled={busy} onChange={notify => { if (notify === 'all' || notify === 'mentions' || notify === 'off') setDraft({ ...draft, notify }); }} />
      <Text variant="supporting" tone="muted">Applies to conversations on all your devices.</Text>
    </Stack>
    {task.error && <ErrorState message={task.error} />}
  </EditorSheet>;
}

/** Picture uploads are their own saved action, never part of a cancellable preferences draft. */
function ProfilePictureEditor({ initial, onClose }: { initial: ProfilePreferences; onClose: () => void }) {
  const current = useQuery(api.preferences.get);
  const [busy, setBusy] = useState(false);
  const guard = useDraftGuard({ dirty: false, busy, onClose });
  return <EditorSheet title="Profile picture" size="content" busy={busy} dismissible={guard.dismissible} onClose={() => void guard.close()}>
    {guard.dialog}
    <ImageControl of="me" name={current?.displayName || initial.displayName || 'You'} image={current ? current.image : initial.image} onBusyChange={setBusy} />
    <Text variant="supporting" tone="muted">Changes save immediately.</Text>
  </EditorSheet>;
}
