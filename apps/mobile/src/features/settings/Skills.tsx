import { useTheme } from '@/design';
import { can } from '@companybot/core/permissions';
import { customSkillError, SKILL_DESCRIPTION_MAX, SKILL_INSTRUCTIONS_MAX, SKILL_NAME_MAX } from '@companybot/core/skills';
import type { FunctionReturnType } from 'convex/server';
import { useState } from 'react';
import { Alert, Platform } from 'react-native';
import { router, Stack as RouterStack, useLocalSearchParams } from 'expo-router';
import { Button, ChoicePicker, Divider, EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Screen, ScreenList, Section, Stack, Text, useConfirm } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { NavigationHeader } from '@/components/navigation/NavigationHeader';
import { HeaderMenu } from '@/components/navigation/HeaderMenu';
import type { Action } from '@/components/ui/ActionMenu';
import { RichText } from '@/features/chat/RichText';

type Skill = FunctionReturnType<typeof api.skills.list>[number];
export default function Skills() {
  const { sizes } = useTheme();
  const skills = useQuery(api.skills.list);
  const me = useQuery(api.workspace.me);
  const { itemId } = useLocalSearchParams<{ itemId?: string }>();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const item = skills?.find((skill) => skill.id === itemId);
  if (itemId) return skills === undefined ? <Screen><Loading /></Screen> : item ? <SkillDetail key={item.id} skill={item} /> : <Screen><EmptyState title="Skill unavailable" description="It may have been removed or you may no longer have access." /></Screen>;
  const query = search.trim().toLocaleLowerCase();
  const active = skills?.filter((skill) => !skill.trash && (!query || `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query)));
  return <>
    <NavigationHeader search={{ placeholder: 'Search skills', value: search, onChange: setSearch }} action={me?.access ? { label: 'New skill', onPress: () => setCreating(true) } : undefined} />
    <Screen nativeScroll padded={false}><ScreenList contentContainerStyle={{ paddingHorizontal: sizes.gutter }} data={active ?? []} keyExtractor={skill => skill.id} ItemSeparatorComponent={Divider}
      renderItem={({ item: skill }) => <ListRow title={skill.name} description={`${skill.audience === 'personal' ? 'Just me' : 'Team'} · ${skill.description}`} onPress={() => router.push({ pathname: '/settings/[section]', params: { section: 'skills', itemId: skill.id } })} />}
      ListEmptyComponent={!skills ? <Loading /> : <EmptyState title={query ? 'No matching skills' : 'No skills yet'} description={query ? 'Try another name or description.' : 'Save a process your agents can follow.'} />} />
    </Screen>
    {creating && <SkillEditor onClose={() => setCreating(false)} />}
  </>;
}
function SkillDetail({ skill }: { skill: Skill }) {
  const [editing, setEditing] = useState(false);
  const me = useQuery(api.workspace.me);
  const share = useMutation(api.skills.share);
  const remove = useMutation(api.skills.remove);
  const task = useTask();
  const { confirm, dialog } = useConfirm();
  const guard = useDraftGuard({ dirty: false, busy: task.busy, onClose: () => {} });
  const editable = !!me?.access && skill.canEdit && !!skill.custom && !skill.trash;
  const shareable = skill.audience === 'personal' && !skill.trash && !!me?.access && can(me.access, 'skills.edit');
  const actions: Action[] = [
    ...(editable ? [{ id: 'edit', title: 'Edit skill', icon: 'pencil' as const }] : []),
    ...(shareable ? [{ id: 'share', title: 'Share with team', icon: 'person.2' as const }] : []),
    ...(skill.canEdit && !skill.trash ? [{ id: 'archive', title: 'Archive skill', icon: 'archivebox' as const, destructive: true }] : []),
  ];
  return <>
    <RouterStack.Screen options={{ title: skill.name }} />
    {actions.length > 0 && <HeaderMenu label="Skill actions" actions={actions.map(action => ({ ...action, disabled: task.busy || editing }))} onAction={id => {
      if (task.busy || editing) return;
      if (id === 'edit' && editable) { task.clear(); setEditing(true); }
      else if (id === 'share' && shareable) void task.run(async () => {
        if (await confirm({ title: 'Share this skill?', body: 'Everyone in the workspace will be able to see and use its instructions.', action: 'Share with team' })) await share({ skillId: skill.id });
      });
      else if (id === 'archive' && skill.canEdit && !skill.trash) void task.run(async () => {
        if (!await confirm({ title: `Archive ${skill.name}?`, body: 'Agents stop seeing it. Its content is kept in Archive.', action: 'Archive', danger: true })) return;
        await remove({ skillId: skill.id }); guard.complete();
        if (router.canGoBack()) router.back();
        else router.replace('/settings/skills');
      });
    }} />}
    <Screen scroll>{dialog}{guard.dialog}
      <Stack gap="xl">
        {task.error && <ErrorState message={task.error} />}
        <Stack gap="sm">
          <Text selectable>{skill.description}</Text>
          <Text variant="supporting" tone="muted">{skill.trash ? 'Archived · ' : ''}{skill.audience === 'personal' ? 'Only you can see and use this skill.' : 'Available to your team.'}</Text>
        </Stack>
        <Section title="Instructions"><RichText value={skill.instructions} /></Section>
        {skill.custom && <Text variant="supporting" tone="muted">Version {skill.custom.version} · Updated by {skill.custom.updatedByName} · {new Date(skill.custom.updatedAt).toLocaleString()}</Text>}
      </Stack>
    </Screen>
    {editing && <SkillEditor skill={skill} onClose={() => setEditing(false)} />}
  </>;
}

function SkillEditor({ skill, onClose }: { skill?: Skill; onClose: () => void }) {
  const [baseline, setBaseline] = useState({ name: skill?.name ?? '', description: skill?.description ?? '', instructions: skill?.instructions ?? '' });
  const [value, setValue] = useState(baseline);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const me = useQuery(api.workspace.me);
  const canShare = !!me?.access && can(me.access, 'skills.edit');
  const [audience, setAudience] = useState<'personal' | 'team'>('personal');
  const [base, setBase] = useState(skill?.custom?.version);
  const create = useMutation(api.skills.create); const save = useMutation(api.skills.save);
  const task = useTask();
  const editable = !!me?.access && (!skill || (skill.canEdit && !!skill.custom && !skill.trash));
  const conflict = !!skill?.custom && skill.custom.version !== base;
  const dirty = (!skill && audience !== 'personal') || value.name !== baseline.name || value.description !== baseline.description || value.instructions !== baseline.instructions;
  const problem = customSkillError(value);
  const guard = useDraftGuard({ dirty, busy: task.busy, onClose, description: 'Your unsaved skill changes will be discarded.' });
  const submit = () => {
    if (!editable || task.busy || conflict || (!skill && audience === 'team' && !canShare)) return;
    setAttemptedSave(true);
    if (problem) {
      // A header action must explain validation even when the field is offscreen.
      if (Platform.OS !== 'web') Alert.alert('Check skill details', problem);
      return;
    }
    void task.run(async () => { if (skill && base !== undefined) await save({ skillId: skill.id, config: value, expectedVersion: base }); else await create({ config: value, audience }); guard.complete(); onClose(); });
  };
  return <EditorSheet title={skill?.name ?? 'New skill'} onClose={() => void guard.close()} busy={task.busy} dismissible={guard.dismissible} submit={editable ? { label: skill ? 'Done' : 'Create', disabled: (!skill && audience === 'team' && !canShare) || conflict || (!!skill && !dirty), onPress: submit } : undefined}>{guard.dialog}
    {conflict && <Stack gap="sm"><Text>This skill changed while you were editing. Reload it before saving.</Text><Button label="Reload latest" variant="secondary" disabled={task.busy} onPress={() => { const latest = { name: skill.name, description: skill.description, instructions: skill.instructions }; setBase(skill.custom?.version); setBaseline(latest); setValue(latest); }} /></Stack>}
    {skill && !editable && <Text tone="muted">This skill is now read only. Your draft is kept until you close it.</Text>}
    {task.error && <ErrorState message={task.error} />}
    {editable && attemptedSave && problem && <ErrorState message={problem} />}
    {!skill && <ChoicePicker label="Who can use it" value={audience} disabled={task.busy} options={[{ value: 'personal', label: 'Just me' }, ...(canShare ? [{ value: 'team', label: 'Team' }] : [])]} onChange={v => { if (v === 'personal' || v === 'team') setAudience(v); }} />}
    {skill && <Text tone="muted">{skill.audience === 'personal' ? 'Only you can see and use this skill.' : 'A skill for your team.'}</Text>}
    <Field label="Name" value={value.name} onChangeText={(name) => setValue({ ...value, name })} editable={editable && !task.busy} maxLength={SKILL_NAME_MAX} />
    <Field label="Description" multiline hint={`What it does and when to use it. ${SKILL_DESCRIPTION_MAX - value.description.trim().length} characters left.`} value={value.description} onChangeText={(description) => setValue({ ...value, description })} editable={editable && !task.busy} maxLength={SKILL_DESCRIPTION_MAX} />
    <Field label="Instructions" hint="Markdown. Agents read this when they load the skill." value={value.instructions} onChangeText={(instructions) => setValue({ ...value, instructions })} multiline editable={editable && !task.busy} maxLength={SKILL_INSTRUCTIONS_MAX} style={{ minHeight: 200 }} />
    <Text tone="muted">Used by agents granted skills.load when a task calls for it.</Text>
    {skill?.custom && <Text variant="caption" tone="muted">v{skill.custom.version} · {skill.custom.updatedByName} · {new Date(skill.custom.updatedAt).toLocaleString()}</Text>}
  </EditorSheet>;
}
