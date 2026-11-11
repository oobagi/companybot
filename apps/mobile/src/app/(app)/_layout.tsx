import { View } from 'react-native';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { Stack } from 'expo-router';
import { NotificationNavigation } from '@/lib/notifications/NotificationNavigation';
import { WorkspaceProvider } from '@/features/session/WorkspaceProvider';
import { useTheme } from '@/design';
import { SessionLinkNavigation } from '@/features/session/SessionLinks';
import { RecentNavigation } from '@/features/pins/RecentNavigation';

export default function AppLayout() {
  const { colors, dark } = useTheme();
  return <WorkspaceProvider><View style={{ flex: 1 }}><SessionLinkNavigation /><NotificationNavigation /><RecentNavigation /><ConnectionStatus /><Stack screenOptions={{ statusBarStyle: dark ? 'light' : 'dark', headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.text, contentStyle: { backgroundColor: colors.background }, headerShadowVisible: false, headerBackButtonDisplayMode: 'minimal' }}>
    <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    <Stack.Screen name="workspaces" options={{ title: 'Workspaces', presentation: 'modal' }} />
    <Stack.Screen name="saved" options={{ title: 'Pinned and recent' }} />
    <Stack.Screen name="components" options={{ title: 'Components' }} />
    <Stack.Screen name="chat/[chatId]/index" options={{ title: 'Conversation' }} />
    <Stack.Screen name="chat/[chatId]/details" options={{ title: 'Conversation details' }} />
    <Stack.Screen name="chat/[chatId]/thread/[threadId]" options={{ title: 'Thread' }} />
    <Stack.Screen name="page/[pageId]" options={{ title: 'Page' }} />
    <Stack.Screen name="pages/[pageId]" options={{ title: 'Page' }} />
    <Stack.Screen name="database/[typeId]" options={{ title: 'Database' }} />
    <Stack.Screen name="record/[recordId]" options={{ title: 'Record' }} />
    <Stack.Screen name="settings/[section]" options={{ title: 'Settings' }} />
  </Stack></View></WorkspaceProvider>;
}
