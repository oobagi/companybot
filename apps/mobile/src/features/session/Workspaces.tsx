import { useState } from 'react';
import { router } from 'expo-router';
import { api } from '@/lib/api';
import { useMutation, useQuery, useWorkspace } from '@/lib/convex';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { Avatar, Badge, Button, Card, EditorSheet, ErrorState, Field, ListRow, Loading, Screen, Section, Stack, Text } from '@/components/ui';
import { useWorkspaceSelection } from './WorkspaceProvider';
import { useWorkspaceTransition } from './useWorkspaceTransition';

export default function Workspaces() {
  const mine = useQuery(api.workspace.mine);
  const activity = useQuery(api.workspace.activity);
  const workspace = useWorkspace();
  const { choose } = useWorkspaceSelection();
  const accept = useMutation(api.workspace.acceptInvite);
  const decline = useMutation(api.workspace.declineInvite);
  const [creating, setCreating] = useState(false);
  const task = useWorkspaceTransition();
  const guard = useDraftGuard({ dirty: false, busy: task.busy, onClose: () => {} });
  if (!mine) return <Screen><Loading /></Screen>;
  return <Screen scroll keyboard><Stack gap="xl">
    <Section title="Your workspaces"><Card>{mine.workspaces.map(w => {
      const unread = activity?.find(a => a.id === w.id);
      return <ListRow key={w.id} title={w.name} description={w.resetting ? 'Resetting…' : w.owner ? 'Owner' : 'Member'} leading={<Avatar name={w.name} image={w.image} />} trailing={unread?.mentions ? <Badge label={String(unread.mentions)} /> : unread?.unread ? <Badge label="Unread" /> : undefined} selected={workspace?.id === w.id} disabled={task.busy} onPress={() => void task.run(async () => { if (workspace?.open(w.id)) { guard.complete(); router.replace('/'); } })} />;
    })}</Card></Section>
    {mine.invitations.length > 0 && <Section title="Invitations">{mine.invitations.map(invite => <Card key={invite.id}><Text variant="heading">{invite.workspace}</Text><Text tone="muted">Invited by {invite.invitedBy ?? 'a workspace owner'} as {invite.roles.join(', ')}</Text><Button label="Join workspace" disabled={task.busy} onPress={() => void task.run(async isCurrent => { const id = await accept({ id: invite.id }); if (isCurrent()) { guard.complete(); choose(id); router.replace('/'); } })} /><Button label="Decline" variant="ghost" disabled={task.busy} onPress={() => void task.run(() => decline({ id: invite.id }), async () => true)} /></Card>)}</Section>}
    <Button label="Create workspace" variant="secondary" disabled={task.busy} onPress={() => void task.run(async () => setCreating(true))} />
    {guard.dialog}
    {task.error && <ErrorState message={task.error} />}
  </Stack>{creating && <CreateWorkspace onClose={() => setCreating(false)} />}</Screen>;
}

function CreateWorkspace({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const create = useMutation(api.workspace.create);
  const { choose } = useWorkspaceSelection();
  const task = useWorkspaceTransition();
  const guard = useDraftGuard({ dirty: !!name.trim(), busy: task.busy, onClose, description: 'Your workspace has not been created. Its name will be discarded.' });
  return <EditorSheet title="New workspace" onClose={() => void guard.close()} busy={task.busy} dismissible={guard.dismissible}>
    {guard.dialog}
    <Field label="Workspace name" value={name} onChangeText={setName} editable={!task.busy} autoFocus />
    {task.error && <ErrorState message={task.error} />}
    <Button label="Create workspace" loading={task.busy} disabled={!name.trim()} onPress={() => void task.run(async isCurrent => {
      const id = await create({ name: name.trim() });
      if (!isCurrent()) return;
      guard.complete(); onClose(); choose(id); router.replace('/');
      // Other edits were approved before opening this sheet; this submission saves its own draft.
    }, async () => true)} />
  </EditorSheet>;
}
