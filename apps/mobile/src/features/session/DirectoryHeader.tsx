import { router } from 'expo-router';
import Workspace from '@expo/material-symbols/domain.xml';
import { NavigationHeader, type NavigationHeaderProps } from '@/components/navigation/NavigationHeader';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';

/** Supplies workspace identity and app destinations to the reusable native header. */
export function DirectoryHeader({ workspaceSwitcher = true, menu = [], ...props }: Omit<NavigationHeaderProps, 'leading'> & { workspaceSwitcher?: boolean }) {
  const me = useQuery(api.workspace.me);
  return <NavigationHeader {...props} menu={workspaceSwitcher ? [
    ...menu,
    { label: 'Pinned and recent', icon: 'pin', onPress: () => router.push('/saved') },
    ...(__DEV__ ? [{ label: 'Components', icon: 'square.grid.2x2' as const, onPress: () => router.push('/components') }] : []),
  ] : menu} leading={workspaceSwitcher ? {
    label: `Switch workspace, ${me?.workspace ?? 'Companybot'}`,
    image: me?.workspaceImage,
    icon: process.env.EXPO_OS === 'ios' ? 'building.2' : Workspace,
    onPress: () => router.push('/workspaces'),
  } : undefined} />;
}
