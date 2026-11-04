import { can } from '@companybot/core/permissions';
import type { FunctionReturnType } from 'convex/server';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Badge, Button, EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Screen, Stack, Text, useConfirm } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction, useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { RoleChoices } from './Roles';

type Connector = FunctionReturnType<typeof api.connectors.list>[number];
export default function Connectors() {
  const connectors = useQuery(api.connectors.list);
  const me = useQuery(api.workspace.me);
  const { itemId } = useLocalSearchParams<{ itemId?: string }>();
  const [selected, setSelected] = useState<string | undefined>(() => typeof itemId === 'string' ? itemId : undefined);
  const item = connectors?.find((connector) => connector.id === selected);
  return <Screen scroll><Stack style={{ flexGrow: 1 }}><Text variant="heading">Connectors</Text><Text tone="muted">Connect outside services so your agents can work with them.</Text>
    {!connectors ? <Loading /> : !connectors.length ? <EmptyState title="No connectors available" description="Services appear here when they are available." /> : connectors.map((connector) => <ListRow key={connector.id} title={connector.name} description={connector.description} trailing={<Badge label={!connector.installed ? 'Not installed' : !connector.canUse ? 'Restricted' : connector.error ? 'Needs attention' : connector.connected ? 'Connected' : 'Not connected'} tone={connector.error ? 'warning' : 'default'} />} onPress={() => setSelected(connector.id)} />)}
    {item && <ConnectorEditor key={item.id} connector={item} owner={!!me?.access && can(me.access, 'connectors.manage')} onClose={() => setSelected(undefined)} />}
  </Stack></Screen>;
}
function ConnectorEditor({ connector, owner, onClose }: { connector: Connector; owner: boolean; onClose: () => void }) {
  const workspaceRoles = useQuery(api.roles.list);
  const install = useMutation(api.connectors.setInstalled); const roles = useMutation(api.connectors.setRoles); const disconnect = useMutation(api.connectors.disconnect);
  const connect = useAction(api.connectors.connect); const oauth = useAction(api.connectors.startOAuth);
  const [key, setKey] = useState(''); const [permissions, setPermissions] = useState(false);
  const task = useTask(); const { confirm, dialog } = useConfirm();
  const guard = useDraftGuard({ dirty: key.length > 0, busy: task.busy || permissions, onClose, description: 'Your unsaved API key will be discarded.' });
  return <EditorSheet title={connector.name} open={!permissions} onClose={() => void guard.close()} dismissible={guard.dismissible} busy={task.busy || permissions} onDismiss={() => {
    if (permissions) { onClose(); router.push({ pathname: '/settings/[section]', params: { section: 'permissions', connectorId: connector.id } }); }
  }}>{dialog}{guard.dialog}
    <Text>{connector.description}</Text><Text variant="caption" tone="muted">{connector.publisher} · v{connector.version}</Text>
    <Text>{connector.connection === 'personal' ? 'Each person connects their own account.' : 'One shared account for the workspace.'}</Text>
    {task.error && <ErrorState message={task.error} />}
    {connector.error && <ErrorState message={`Last connection attempt: ${connector.error}`} />}
    {owner && <Button label={connector.installed ? 'Remove connector' : 'Install connector'} variant={connector.installed ? 'danger' : 'primary'} disabled={!workspaceRoles?.length} loading={task.busy} onPress={() => void task.run(async () => {
      if (connector.installed && !await confirm({ title: `Remove ${connector.name}?`, body: 'This disconnects it for everyone and deletes saved connections and permissions. Reinstalling requires connecting again.', action: 'Remove connector', danger: true })) return;
      await install({ connectorId: connector.id, installed: !connector.installed });
    })} />}
    {connector.installed && <>
      <Text variant="label">Roles that can use it</Text>
      {!workspaceRoles?.length ? <Loading layout="inline" label="Workspace roles are being set up…" /> : <RoleChoices roles={workspaceRoles.filter(role => role.builtIn !== 'owner')} value={workspaceRoles.filter(role => connector.roles.includes(role.id)).map(role => role.id)} disabled={!owner || task.busy} onChange={value => void task.run(() => roles({ connectorId: connector.id, roles: value, expectedRoles: connector.roles }))} />}
      <Text variant="caption" tone="muted">Owners always have access. People with any selected role can use this connector.</Text>
      {connector.auth.type === 'none' ? <Text>Ready. No account needed.</Text> : connector.connected ? <>
        <Badge label="Connected" tone="success" />{connector.canConnect && <Button label="Disconnect" variant="danger" disabled={task.busy} onPress={() => void task.run(async () => { if (!await confirm({ title: `Disconnect ${connector.name}?`, body: 'This deletes the saved connection. Connect again before agents can use it.', action: 'Disconnect', danger: true })) return; await disconnect({ connectorId: connector.id }); })} />}
      </> : connector.canUse && connector.canConnect ? connector.auth.type === 'oauth' ? <>
        <Button label={`Connect ${connector.name}`} loading={task.busy} onPress={() => void task.run(async () => {
          const url = await oauth({ connectorId: connector.id });
          if (!/^https:\/\//i.test(url)) throw new Error('The sign-in service returned an invalid address.');
          // This flow ends at the backend callback, which saves the connection. No mobile callback or token exchange is needed.
          await WebBrowser.openBrowserAsync(url);
        })} /><Text tone="muted">Finish connecting in your browser, then return here. Connection status updates automatically.</Text>
      </> : <>
        <Field label={connector.auth.type === 'api_key' ? connector.auth.label : 'API key'} hint={connector.auth.type === 'api_key' ? connector.auth.help : undefined} value={key} onChangeText={setKey} editable={!task.busy} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" />
        <Button label="Connect" loading={task.busy} disabled={!key.trim()} onPress={() => void task.run(async () => { await connect({ connectorId: connector.id, credentials: { type: 'api_key', key: key.trim() } }); setKey(''); })} />
      </> : <Text tone="muted">{connector.canUse ? 'A workspace owner needs to connect it.' : 'Your role cannot use this connector.'}</Text>}
      {connector.canUse && <Button label="Action permissions" variant="secondary" disabled={task.busy} onPress={() => void task.run(async () => {
        if (key && !await confirm({ title: 'Discard API key?', body: 'The key has not been saved. Discard it and open action permissions?', action: 'Discard and continue', danger: true })) return;
        setKey(''); setPermissions(true);
      })} />}
      <Text variant="caption" tone="muted">Grant {connector.id}.* to an agent to let it use this connector. Actions that change something ask first unless you allow them.</Text>
    </>}
  </EditorSheet>;
}
