import { can } from '@companybot/core/permissions';
import { SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX } from '@companybot/core/skills';
import type { FunctionReturnType } from 'convex/server';
import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Button, Card, EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Screen, Stack, Text, useConfirm } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { DirectoryHeader } from '@/components/navigation/DirectoryHeader';

type Skill = FunctionReturnType<typeof api.skills.list>[number];
export default function Skills() {
  const skills = useQuery(api.skills.list);
  const me = useQuery(api.workspace.me);
  const { itemId } = useLocalSearchParams<{ itemId?: string }>();
  const [selected, setSelected] = useState<string | undefined>(() => typeof itemId === 'string' ? itemId : undefined);
  const item = skills?.find((skill) => skill.id === selected);
  const active = skills?.filter((skill) => !skill.trash);
  return <><DirectoryHeader workspaceSwitcher={false} action={me?.role && can(me.role, 'skills.create') ? { label: 'New skill', onPress: () => setSelected('new') } : undefined} /><Screen scroll><Stack style={{ flexGrow: 1 }}>
    {!skills ? <Loading /> : !active?.length ? <EmptyState title="No skills yet" description="Save a process your agents can follow." /> : active.map((skill) => <ListRow key={skill.id} title={skill.name} description={skill.description} onPress={() => setSelected(skill.id)} />)}
    {(selected === 'new' || item) && <SkillEditor key={selected} skill={item} onClose={() => setSelected(undefined)} />}
  </Stack></Screen></>;
}
function SkillEditor({ skill, onClose }: { skill?: Skill; onClose: () => void }) {
  const [value, setValue] = useState({ name: skill?.name ?? '', description: skill?.description ?? '', instructions: skill?.instructions ?? '' });
  const [base, setBase] = useState(skill?.custom?.version);
  const create = useMutation(api.skills.create); const save = useMutation(api.skills.save); const remove = useMutation(api.skills.remove);
  const task = useTask(); const { confirm, dialog } = useConfirm();
  const editable = !skill || (skill.canEdit && !!skill.custom && !skill.trash);
  const conflict = !!skill?.custom && skill.custom.version !== base;
  const dirty = value.name !== (skill?.name ?? '') || value.description !== (skill?.description ?? '') || value.instructions !== (skill?.instructions ?? '');
  const close = async () => { if (!editable || !dirty || await confirm({ title: 'Discard changes?', body: 'Your unsaved skill changes will be discarded.', action: 'Discard', danger: true })) onClose(); };
  return <EditorSheet title={skill?.name ?? 'New skill'} onClose={() => void close()} busy={task.busy} dismissible={!editable || !dirty}>{dialog}
    {conflict && <Card><Text>This skill changed while you were editing. Reload it before saving.</Text><Button label="Reload latest" variant="secondary" onPress={() => { setBase(skill.custom?.version); setValue({ name: skill.name, description: skill.description, instructions: skill.instructions }); }} /></Card>}
    {task.error && <ErrorState message={task.error} />}
    <Field label="Name" value={value.name} onChangeText={(name) => setValue({ ...value, name })} editable={editable} maxLength={SKILL_NAME_MAX} />
    <Field label="Description" hint={`What it does and when to use it. ${SKILL_DESCRIPTION_MAX - value.description.trim().length} characters left.`} value={value.description} onChangeText={(description) => setValue({ ...value, description })} editable={editable} />
    <Field label="Instructions" hint="Markdown. Agents read this when they load the skill." value={value.instructions} onChangeText={(instructions) => setValue({ ...value, instructions })} multiline editable={editable} style={{ minHeight: 200 }} />
    <Text tone="muted">Used by agents granted skills.load when a task calls for it.</Text>
    {skill?.custom && <Text variant="caption" tone="muted">v{skill.custom.version} · {skill.custom.updatedByName} · {new Date(skill.custom.updatedAt).toLocaleString()}</Text>}
    {editable && <Button label={skill ? 'Save skill' : 'Create skill'} loading={task.busy} disabled={!value.name.trim() || conflict || (skill && !dirty)} onPress={() => void task.run(async () => { if (skill && base !== undefined) await save({ skillId: skill.id, config: value, expectedVersion: base }); else await create({ config: value }); onClose(); })} />}
    {skill?.canEdit && !skill.trash && <Button label="Archive skill" variant="danger" disabled={task.busy} onPress={() => void task.run(async () => { if (!await confirm({ title: `Archive ${skill.name}?`, body: 'Agents stop seeing it. Its content is kept in Archive.', action: 'Archive', danger: true })) return; await remove({ skillId: skill.id }); onClose(); })} />}
  </EditorSheet>;
}
