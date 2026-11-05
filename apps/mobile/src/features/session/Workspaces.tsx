import { useState } from 'react';
import { router } from 'expo-router';
import { useUnsavedWork } from '@/lib/UnsavedWork';
import { api } from '@/lib/api';
import { useMutation, useQuery, useWorkspace } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { Avatar, Badge, Button, Card, EditorSheet, ErrorState, Field, ListRow, Loading, Screen, Section, Stack, Text } from '@/components/ui';
import { useConfirm } from '@/components/ui/useConfirm';
import { useWorkspaceSelection } from './WorkspaceProvider';

export default function Workspaces() {
  const { confirmDiscard } = useUnsavedWork();
  const mine = useQuery(api.workspace.mine);
  const activity = useQuery(api.workspace.activity);
  const workspace = useWorkspace();
  const { choose } = useWorkspaceSelection();
  const create = useMutation(api.workspace.create);
  const accept = useMutation(api.workspace.acceptInvite);
  const decline = useMutation(api.workspace.declineInvite);
  const [creating, setCreating] = useState(false);
  // Transition tasks run their own discard check before choosing a workspace.
  const task = useTask({ guardWorkspace: false });
  if (!mine) return <Screen><Loading /></Screen>;
  return <Screen scroll keyboard><Stack gap="xl">
    <Section title="Your workspaces"><Card>{mine.workspaces.map(w => {
      const unread = activity?.find(a => a.id === w.id);
      return <ListRow key={w.id} title={w.name} description={w.resetting ? 'Resetting…' : w.owner ? 'Owner' : 'Member'} leading={<Avatar name={w.name} image={w.image} />} trailing={unread?.mentions ? <Badge label={String(unread.mentions)} /> : unread?.unread ? <Badge label="Unread" /> : undefined} selected={workspace?.id === w.id} onPress={() => void task.run(async () => { if (await confirmDiscard() && workspace?.open(w.id)) router.replace('/'); })} />;
    })}</Card></Section>
    {mine.invitations.length > 0 && <Section title="Invitations">{mine.invitations.map(invite => <Card key={invite.id}><Text variant="heading">{invite.workspace}</Text><Text tone="muted">Invited by {invite.invitedBy ?? 'a workspace owner'} as {invite.roles.join(', ')}</Text><Button label="Join workspace" disabled={task.busy} onPress={() => void task.run(async () => { if (!await confirmDiscard()) return; choose(await accept({ id: invite.id })); router.replace('/'); })} /><Button label="Decline" variant="ghost" disabled={task.busy} onPress={() => void task.run(() => decline({ id: invite.id }))} /></Card>)}</Section>}
    <Button label="Create workspace" variant="secondary" disabled={task.busy} onPress={() => setCreating(true)} />
    {task.error && <ErrorState message={task.error} />}
  </Stack>{creating && <CreateWorkspace onClose={() => setCreating(false)} onCreate={async name => {
    if (!await confirmDiscard()) return;
    choose(await create({ name })); setCreating(false); router.replace('/');
  }} />}</Screen>;
}

function CreateWorkspace({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const task = useTask({ guardWorkspace: false });
  const { confirm, dialog } = useConfirm();
  const close = async () => {
    if (task.busy) return;
    if (!name.trim() || await confirm({ title: 'Discard workspace?', body: 'Your workspace has not been created. Discard its name?', action: 'Discard', danger: true })) onClose();
  };
  return <EditorSheet title="New workspace" onClose={() => void close()} busy={task.busy} dismissible={!name.trim()}>
    {dialog}
    <Field label="Workspace name" value={name} onChangeText={setName} editable={!task.busy} autoFocus />
    {task.error && <ErrorState message={task.error} />}
    <Button label="Create workspace" loading={task.busy} disabled={!name.trim()} onPress={() => void task.run(() => onCreate(name.trim()))} />
  </EditorSheet>;
}
