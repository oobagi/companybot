import { can } from '@companybot/core/permissions';
import type { FunctionReturnType } from 'convex/server';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { router, Stack as RouterStack, useLocalSearchParams } from 'expo-router';
import { Badge, Button, Divider, EditorSheet, EmptyState, ErrorState, Field, GroupedList, ListRow, Loading, Screen, ScreenList, Text, useConfirm } from '@/components/ui';
import { HeaderMenu } from '@/components/navigation/HeaderMenu';
import { NavigationHeader } from '@/components/navigation/NavigationHeader';
import { api } from '@/lib/api';
import { useAction, useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { RoleChoices, roleNames, type WorkspaceRole } from './Roles';

type Connector = FunctionReturnType<typeof api.connectors.list>[number];
type Task = ReturnType<typeof useTask>;
const connectionStatus = (connector: Connector) => !connector.installed ? 'Not installed' : !connector.canUse ? 'Restricted' : connector.auth.type === 'none' ? 'Ready' : connector.error ? 'Needs attention' : connector.connected ? 'Connected' : 'Not connected';

export default function Connectors() {
  const connectors = useQuery(api.connectors.list);
  const me = useQuery(api.workspace.me);
  const { itemId } = useLocalSearchParams<{ itemId?: string }>();
  const [search, setSearch] = useState('');
  const item = connectors?.find(connector => connector.id === itemId);
  if (itemId) return !connectors ? <Screen><Loading /></Screen> : item ? <ConnectorDetail key={item.id} connector={item} owner={!!me?.access && can(me.access, 'connectors.manage')} /> : <Screen><EmptyState title="Connector unavailable" description="It may no longer be available to this workspace." /></Screen>;
  const query = search.trim().toLocaleLowerCase();
  const visible = connectors?.filter(connector => !query || `${connector.name} ${connector.description}`.toLocaleLowerCase().includes(query));
  return <>
    <NavigationHeader search={{ placeholder: 'Search connectors', value: search, onChange: setSearch }} />
    <Screen nativeScroll padded={false}><ScreenList data={visible ?? []} keyExtractor={connector => connector.id} ItemSeparatorComponent={Divider}
      renderItem={({ item: connector }) => <ListRow title={connector.name} description={connector.description} trailing={<Badge label={connectionStatus(connector)} tone={connector.error && connector.canUse ? 'warning' : 'default'} />} onPress={() => router.push({ pathname: '/settings/[section]', params: { section: 'connectors', itemId: connector.id } })} />}
      ListEmptyComponent={!connectors ? <Loading /> : <EmptyState title={query ? 'No matching connectors' : 'No connectors available'} description={query ? 'Try another service name or description.' : 'Services appear here when they are available.'} />} />
    </Screen>
  </>;
}

function ConnectorDetail({ connector, owner }: { connector: Connector; owner: boolean }) {
  const workspaceRoles = useQuery(api.roles.list);
  const install = useMutation(api.connectors.setInstalled);
  const disconnect = useMutation(api.connectors.disconnect);
  const [mode, setMode] = useState<'connection' | 'roles'>();
  // Uninstalling remotely retires any editor; reinstalling must not reopen an old credential draft.
  if (mode && !connector.installed) setMode(undefined);
  const task = useTask();
  const { confirm, dialog } = useConfirm();
  const guard = useDraftGuard({ dirty: false, busy: task.busy, onClose: () => {} });
  const open = (next: typeof mode) => { if (!task.busy) { task.clear(); setMode(next); } };
  const signIn = { none: 'No account needed', api_key: 'API key', oauth: 'Sign in through your browser' }[connector.auth.type];
  const canConnect = connector.installed && connector.canUse && connector.canConnect && connector.auth.type !== 'none';
  const installConnector = () => { if (owner && !connector.installed && workspaceRoles?.length) void task.run(() => install({ connectorId: connector.id, installed: true })); };
  const actions = [
    ...(connector.installed && connector.connected && connector.canConnect && connector.auth.type !== 'none' ? [{ id: 'disconnect', title: connector.connection === 'personal' ? 'Disconnect your account' : 'Disconnect account', destructive: true }] : []),
    ...(connector.installed && owner ? [{ id: 'remove', title: 'Remove connector', destructive: true }] : []),
  ].map(action => ({ ...action, disabled: task.busy || !!mode }));
  const allowedRoles = workspaceRoles?.filter(role => role.builtIn === 'owner' || connector.roleIds.includes(role.id));
  return <>
    <RouterStack.Screen options={{ title: connector.name }} />
    {actions.length > 0 && <HeaderMenu label="Connector actions" actions={actions} onAction={id => {
      if (task.busy || mode || !connector.installed) return;
      void task.run(async () => {
        if (id === 'remove' && owner) {
          if (!await confirm({ title: `Remove ${connector.name}?`, body: 'This disconnects it for everyone and deletes saved connections and permissions. Reinstalling requires connecting again.', action: 'Remove connector', danger: true })) return;
          await install({ connectorId: connector.id, installed: false });
        }
        if (id === 'disconnect' && connector.connected && connector.canConnect) {
          if (!await confirm({ title: `Disconnect ${connector.name}?`, body: 'This deletes the saved connection. Connect again before agents can use it.', action: 'Disconnect', danger: true })) return;
          await disconnect({ connectorId: connector.id });
        }
      });
    }} />}
    <Screen nativeScroll padded={false}>{dialog}{guard.dialog}
      <GroupedList sections={[
        ...(task.error && !mode ? [{ id: 'error', rows: [{ id: 'error', title: 'Could not complete the action', subtitle: task.error }] }] : []),
        { id: 'about', rows: [{ id: 'description', title: connector.description, subtitle: `${connector.publisher} · v${connector.version}` }] },
        { id: 'connection', title: 'Connection', footer: connector.connection === 'personal' ? 'Each person connects their own account.' : 'One shared account for the workspace.', rows: [
          { id: 'status', title: 'Status', value: connectionStatus(connector) },
          { id: 'sign-in', title: 'Sign-in', value: signIn },
          ...(!connector.installed ? [{ id: 'install', title: owner ? 'Install connector' : 'A workspace owner needs to install this connector', onPress: owner ? installConnector : undefined, disabled: task.busy || (owner && !workspaceRoles?.length) }] : canConnect && !connector.connected ? [{ id: 'connect', title: connector.connection === 'personal' ? 'Connect your account' : 'Connect account', onPress: () => open('connection'), disabled: task.busy }] : connector.auth.type !== 'none' && !connector.connected ? [{ id: 'restricted', title: connector.canUse ? 'A workspace owner needs to connect it' : 'Your role cannot use this connector' }] : []),
          ...(connector.error && connector.canUse ? [{ id: 'connection-error', title: 'Last connection attempt failed', subtitle: connector.error }] : []),
        ] },
        ...(connector.installed ? [{ id: 'access', title: 'Access', footer: 'Owners always have access. People with any selected role can use this connector.', rows: [
          { id: 'roles', title: 'Who can use it', subtitle: allowedRoles ? roleNames(allowedRoles.map(role => role.id), allowedRoles) : 'Loading roles…', onPress: owner ? () => open('roles') : undefined, disabled: task.busy || !workspaceRoles?.length },
          ...(connector.canUse ? [{ id: 'permissions', title: 'Action permissions', onPress: () => router.push({ pathname: '/settings/[section]', params: { section: 'permissions', connectorId: connector.id } }), disabled: task.busy }] : []),
        ] }] : []),
        { id: 'tools', title: 'Tools', footer: `Grant ${connector.id}.* to an agent to let it use this connector. Actions that change something ask first unless you allow them.`, rows: [{ id: 'server', title: 'Server', subtitle: connector.server }] },
      ]} />
    </Screen>
    {mode === 'roles' && connector.installed && <ConnectorRoles connector={connector} owner={owner} roles={workspaceRoles ?? undefined} task={task} onClose={() => setMode(undefined)} />}
    {mode === 'connection' && connector.installed && <ConnectionSheet connector={connector} task={task} onClose={() => setMode(undefined)} />}
  </>;
}

function ConnectorRoles({ connector, owner, roles, task, onClose }: { connector: Connector; owner: boolean; roles?: WorkspaceRole[]; task: Task; onClose: () => void }) {
  const setRoles = useMutation(api.connectors.setRoles);
  return <EditorSheet title="Who can use it" size="content" busy={task.busy} onClose={onClose}>
    <Text tone="muted">Owners always have access. Changes save immediately.</Text>
    {task.error && <ErrorState message={task.error} />}
    {!roles?.length ? <Loading layout="inline" label="Workspace roles are being set up…" /> : <RoleChoices roles={roles.filter(role => role.builtIn !== 'owner')} value={roles.filter(role => connector.roleIds.includes(role.id)).map(role => role.id)} disabled={!owner || task.busy} onChange={value => { if (owner && connector.installed) void task.run(() => setRoles({ connectorId: connector.id, roles: value, expectedRoles: connector.roleIds })); }} />}
  </EditorSheet>;
}

function ConnectionSheet({ connector, task, onClose }: { connector: Connector; task: Task; onClose: () => void }) {
  const connect = useAction(api.connectors.connect);
  const oauth = useAction(api.connectors.startOAuth);
  const [key, setKey] = useState('');
  const permitted = connector.canUse && connector.canConnect && connector.installed;
  const guard = useDraftGuard({ dirty: key.length > 0, busy: task.busy, onClose, description: 'Your unsaved API key will be discarded.' });
  return <EditorSheet title={`Connect ${connector.name}`} size="content" onClose={() => void guard.close()} dismissible={guard.dismissible} busy={task.busy}>{guard.dialog}
    <Text tone="muted">{connector.connection === 'personal' ? 'Connect your own account. Other people connect theirs separately.' : 'This connection will be shared with people who can use this connector.'}</Text>
    {task.error && <ErrorState message={task.error} />}
    {!permitted ? <Text>Your access changed. You can no longer connect this account.</Text> : connector.connected ? <Text>Connected. You can close this sheet.</Text> : connector.auth.type === 'oauth' ? <>
      <Text>Finish connecting in your browser, then return here. Connection status updates automatically.</Text>
      <Button label={`Connect ${connector.name}`} loading={task.busy} onPress={() => void task.run(async () => {
        const url = await oauth({ connectorId: connector.id });
        if (!/^https:\/\//i.test(url)) throw new Error('The sign-in service returned an invalid address.');
        // The backend callback saves the connection; no mobile token exchange is needed.
        await WebBrowser.openBrowserAsync(url);
      })} />
    </> : connector.auth.type === 'api_key' ? <>
      <Field label={connector.auth.label} hint={connector.auth.help} value={key} onChangeText={setKey} editable={!task.busy} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" autoFocus />
      <Button label="Connect" loading={task.busy} disabled={!key.trim()} onPress={() => void task.run(async () => { await connect({ connectorId: connector.id, credentials: { type: 'api_key', key: key.trim() } }); setKey(''); guard.complete(); onClose(); })} />
    </> : <Text>Ready. No account needed.</Text>}
  </EditorSheet>;
}
