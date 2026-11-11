import { NativeTabs } from 'expo-router/native-tabs';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';

export default function TabsLayout() {
  const { colors } = useTheme();
  const chats = useQuery(api.chats.list);
  const unread = chats ? [...chats.channels, ...chats.dms].filter(c => c.unread).length : 0;
  return (
    <NativeTabs tintColor={colors.text}>
      <NativeTabs.Trigger name="(chats)" testID="tab-chats">
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'bubble.left.and.bubble.right', selected: 'bubble.left.and.bubble.right.fill' }} md="chat" />
        {unread > 0 && <NativeTabs.Trigger.Badge>{unread > 99 ? '99+' : String(unread)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="pages" testID="tab-pages">
        <NativeTabs.Trigger.Label>Pages</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'doc.on.doc', selected: 'doc.on.doc.fill' }} md="description" />
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
