import { useState } from 'react';
import { Linking } from 'react-native';
import { Button, EditorSheet, ListRow, Text } from '@/components/ui';
import { useNotifications } from '@/lib/notifications/NotificationsProvider';

/** Device opt-in is independent of the shared DM/mention preference. */
export function NotificationsControl() {
  const notifications = useNotifications();
  const [open, setOpen] = useState(false);
  const status = notifications.setup ? 'Unavailable' : notifications.enabled ? 'On' : notifications.denied ? 'Blocked in device settings' : 'Off';
  return <>
    <ListRow title="On this device" description={status} onPress={() => setOpen(true)} />
    {open && <EditorSheet title="Device notifications" onClose={() => setOpen(false)} busy={notifications.busy}>
      <Text tone="muted">Get notified while Companybot is in the background. Your conversation preference controls which messages notify you.</Text>
      {notifications.setup ? <Text tone="muted">Notifications are not available in this version of Companybot.</Text> : <>
        <Text>{notifications.enabled ? 'Notifications are on.' : notifications.denied ? 'Allow Companybot notifications in your device settings.' : 'Notifications are off.'}</Text>
        {notifications.denied && <Button label="Open device settings" variant="secondary" onPress={() => void Linking.openSettings().catch(notifications.reportError)} />}
        <Button label={notifications.requested ? 'Turn off notifications' : 'Enable notifications'} disabled={!notifications.ready || (!notifications.requested && notifications.denied)} loading={notifications.busy} onPress={() => void (notifications.requested ? notifications.disable() : notifications.enable())} />
        {notifications.requested && notifications.error && !notifications.denied && <Button label="Retry enabling notifications" variant="ghost" disabled={!notifications.ready} loading={notifications.busy} onPress={() => void notifications.enable()} />}
      </>}
      {notifications.error && <Text tone="danger" accessibilityRole="alert">{notifications.error}</Text>}
    </EditorSheet>}
  </>;
}
