import { NativeTabs } from 'expo-router/native-tabs';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';

export default function TabsLayout() {
  const { colors } = useTheme();
  const chats = useQuery(api.chats.list);
  // Desktop's rule: a count of chats with a mention or an unread DM, else a dot for any unread.
  const waiting = chats ? [...chats.channels, ...chats.dms] : [];
  const mentions = waiting.filter(c => c.mentioned || (c.kind === 'dm' && c.unread)).length;
  const unread = waiting.some(c => c.unread);
  return (
    <NativeTabs tintColor={colors.text}>
      <NativeTabs.Trigger name="(chats)" testID="tab-chats">
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'bubble.left.and.bubble.right', selected: 'bubble.left.and.bubble.right.fill' }} md="chat" />
        {mentions > 0 ? <NativeTabs.Trigger.Badge>{mentions > 99 ? '99+' : String(mentions)}</NativeTabs.Trigger.Badge> : unread && <NativeTabs.Trigger.Badge>{' '}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="pages" testID="tab-drive">
        <NativeTabs.Trigger.Label>Drive</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'folder', selected: 'folder.fill' }} md="folder" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="databases" testID="tab-databases">
        <NativeTabs.Trigger.Label>Databases</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'tray.2', selected: 'tray.2.fill' }} md="table_chart" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings" testID="tab-settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
