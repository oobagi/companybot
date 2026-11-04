import { View } from 'react-native';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { Stack } from 'expo-router';
import { NotificationNavigation } from '@/lib/notifications/NotificationNavigation';
import { WorkspaceProvider } from '@/features/session/WorkspaceProvider';
import { useTheme } from '@/design';

export default function AppLayout() {
  const { colors } = useTheme();
  return <WorkspaceProvider><View style={{ flex: 1 }}><NotificationNavigation /><ConnectionStatus /><Stack screenOptions={{ headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.text, contentStyle: { backgroundColor: colors.background }, headerShadowVisible: false, headerBackButtonDisplayMode: 'minimal' }}>
    <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    <Stack.Screen name="workspaces" options={{ title: 'Workspaces', presentation: 'modal' }} />
    <Stack.Screen name="chat/[chatId]/index" options={{ title: 'Conversation' }} />
    <Stack.Screen name="chat/[chatId]/details" options={{ title: 'Conversation details' }} />
    <Stack.Screen name="chat/[chatId]/thread/[threadId]" options={{ title: 'Thread' }} />
    <Stack.Screen name="pages/[pageId]" options={{ title: 'Page' }} />
    <Stack.Screen name="database/[typeId]" options={{ title: 'Database' }} />
    <Stack.Screen name="record/[recordId]" options={{ title: 'Record' }} />
    <Stack.Screen name="settings/[section]" options={{ title: 'Settings' }} />
  </Stack></View></WorkspaceProvider>;
}
