// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getFunctionName, type FunctionReference, type FunctionReturnType } from 'convex/server';
import { Alert } from 'react-native';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { api } from '@/lib/api';
import Automations from './Automations';

type Automation = FunctionReturnType<typeof api.automations.list>[number];
const fixture = vi.hoisted(() => ({ items: [] as Automation[], itemId: 'custom-qa' as string | undefined, dirty: false, owner: true, write: vi.fn(async () => {}) }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, Alert: { alert: vi.fn() } }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ itemId: fixture.itemId }), Stack: { Screen: () => null }, router: { push: vi.fn(), back: vi.fn() } }));
vi.mock('@/design', () => ({ useTheme: () => ({ sizes: { gutter: 20 }, spacing: { lg: 20 } }) }));
vi.mock('@/lib/convex', () => ({
  useQuery: (query: FunctionReference<'query'>) => {
    const name = getFunctionName(query);
    if (name === 'automations:list') return fixture.items;
    if (name === 'agents:list') return [{ _id: 'agent-1', name: 'Companybot', archived: false }];
    if (name === 'chats:list') return { channels: [] };
    if (name === 'wakeups:list') return [];
    return { access: { owner: fixture.owner, permissions: [], roles: [] } };
  },
  useMutation: () => fixture.write,
}));
vi.mock('@/lib/useTask', () => ({ useTask: () => ({ busy: false, error: undefined, clear: () => {}, run: async (job: () => Promise<unknown>) => job() }) }));
vi.mock('@/lib/useDraftGuard', () => ({ useDraftGuard: ({ dirty, onClose }: { dirty: boolean; onClose: () => void }) => { fixture.dirty = dirty; return { dismissible: !dirty, close: onClose, complete: () => {}, dialog: null }; } }));
vi.mock('./customize/PendingWakeups', () => ({ PendingWakeups: () => null }));
vi.mock('@/components/ui/native-controls/TimeInput', () => ({ TimeInput: ({ label, value, disabled, onChange }: { label: string; value: string; disabled?: boolean; onChange: (value: string) => void }) => createElement('input', { 'aria-label': label, value, disabled, onInput: (event: { currentTarget: HTMLInputElement }) => onChange(event.currentTarget.value) }) }));
vi.mock('@/components/navigation/NavigationHeader', () => ({ NavigationHeader: ({ action }: { action?: { label: string; onPress: () => void } }) => action && createElement('button', { onClick: action.onPress }, action.label) }));
vi.mock('@/components/navigation/HeaderMenu', () => ({ HeaderMenu: ({ actions, onAction }: { actions: { id: string; title: string; disabled?: boolean }[]; onAction: (id: string) => void }) => actions.map(action => createElement('button', { key: action.id, disabled: action.disabled, onClick: () => onAction(action.id) }, action.title)) }));
vi.mock('@/components/ui', () => {
  const container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const button = ({ label, disabled, onPress }: { label?: string; disabled?: boolean; onPress?: () => void }) => createElement('button', { disabled, onClick: onPress }, label);
  return {
    Button: button, Stack: container, Screen: container, Text: container, Section: container,
    Divider: () => null, Badge: () => null, ListRow: () => null,
    ScreenList: () => null,
    SettingsList: () => null,
    ChoicePicker: ({ label, value, disabled, options, onChange }: { label: string; value: string | string[]; disabled?: boolean; options: { label: string; value: string }[]; onChange: (value: string) => void }) => createElement('select', { 'aria-label': label, value, disabled, multiple: Array.isArray(value), onChange: (event: { currentTarget: HTMLSelectElement }) => onChange(event.currentTarget.value) }, options.map(option => createElement('option', { key: option.value, value: option.value }, option.label))),
    EmptyState: ({ title }: { title: string }) => createElement('p', null, title), Loading: () => createElement('p', null, 'Loading'),
    ErrorState: ({ message }: { message: string }) => createElement('p', { role: 'alert' }, message),
    Field: ({ label, value, onChangeText, editable }: { label: string; value: string; onChangeText: (value: string) => void; editable: boolean }) => createElement('input', { 'aria-label': label, value, disabled: !editable, onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText(event.currentTarget.value) }),
    EditorSheet: ({ children, submit, onClose }: { children: ReactNode; submit?: { label?: string; disabled?: boolean; onPress: () => void }; onClose: () => void }) => createElement('section', null,
      createElement('button', { onClick: onClose }, submit ? 'Cancel' : 'Close'), submit && button(submit), children),
    useConfirm: () => ({ confirm: async () => false, dialog: null }),
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
const render = () => root.render(createElement(Automations));
const button = (label: string) => [...host.querySelectorAll('button')].find(button => button.textContent === label);
const input = (label: string) => host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
const fill = async (label: string, value: string) => act(async () => { const field = input(label); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); });
beforeEach(() => {
  fixture.itemId = 'custom-qa'; fixture.owner = true; fixture.dirty = false;
  fixture.items = [{ id: 'custom-qa', name: 'Morning brief', description: 'Daily', details: '', version: '1', publisher: 'Your team', trigger: 'Daily', triggerType: 'schedule', scheduled: true, runsFor: 'Just you', prompt: 'Summarize tasks.', custom: { name: 'Morning brief', prompt: 'Summarize tasks.', trigger: { type: 'schedule', cron: '0 9 * * *' }, version: 1, updatedByName: 'Jaden', updatedAt: 0 }, createdByName: 'Jaden', canEdit: true, installed: true, enabled: false, audience: 'creator', subscribed: false, subscriberCount: 0, agentId: 'agent-1' as Automation['agentId'], agentName: 'Companybot', agentArchived: false, channelId: null, channelName: null, channelArchived: false, webhookUrl: null, timeZone: 'UTC', lastRunAt: null, lastResult: null, trash: null }];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); fixture.write.mockClear(); vi.mocked(Alert.alert).mockClear(); });

it('keeps an explicit configuration draft after edit permission is lost', async () => {
  await act(async () => render());
  expect(host.querySelector('input')).toBeNull();
  await act(async () => button('Edit configuration')!.click());
  await fill('Name', 'My draft');
  expect(button('Done')?.disabled).toBe(false);
  fixture.items = [{ ...fixture.items[0], canEdit: false }];
  await act(async () => render());
  expect(input('Name').value).toBe('My draft');
  expect(input('Name').disabled).toBe(true);
  expect(fixture.dirty).toBe(true);
  expect(button('Done')).toBeUndefined();
  expect(fixture.write).not.toHaveBeenCalled();
});

it('reloads the visible schedule controls with the latest version before saving', async () => {
  await act(async () => render());
  await act(async () => button('Edit configuration')!.click());
  expect(input('Time').value).toBe('09:00');
  await fill('Name', 'Local draft');
  const previous = fixture.items[0];
  fixture.items = [{ ...previous, custom: { ...previous.custom!, name: 'Remote name', trigger: { type: 'schedule', cron: '30 14 * * *' }, version: 2 } }];
  await act(async () => render());
  expect(input('Name').value).toBe('Local draft');
  expect(button('Done')?.disabled).toBe(true);
  await act(async () => button('Reload latest')!.click());
  expect(input('Name').value).toBe('Remote name');
  expect(input('Time').value).toBe('14:30');
  await fill('Name', 'Reviewed name');
  await act(async () => button('Done')!.click());
  expect(fixture.write).toHaveBeenCalledWith({ automationId: 'custom-qa', expectedVersion: 2, config: { name: 'Reviewed name', prompt: 'Summarize tasks.', trigger: { type: 'schedule', cron: '30 14 * * *' } } });
});

it('saves native time-row edits through the shared cron representation', async () => {
  await act(async () => render());
  await act(async () => button('Edit configuration')!.click());
  await act(async () => button('Add time')!.click());
  expect(input('Time 1').value).toBe('09:00');
  expect(input('Time 2').value).toBe('10:00');
  await fill('Time 2', '13:00');
  await act(async () => button('Done')!.click());
  expect(fixture.write).toHaveBeenCalledWith({ automationId: 'custom-qa', expectedVersion: 1, config: { name: 'Morning brief', prompt: 'Summarize tasks.', trigger: { type: 'schedule', cron: '0 9,13 * * *' } } });
});

it('explains invalid creation without writing and retains the form for correction', async () => {
  fixture.itemId = undefined;
  await act(async () => render());
  await act(async () => button('New automation')!.click());
  await act(async () => button('Create')!.click());
  expect(Alert.alert).toHaveBeenCalledWith('Check automation details', 'Give it a name.');
  await fill('Name', 'Brief'); await fill('What to ask the agent', 'Summarize tasks.'); await fill('Time zone', 'Not/AZone');
  await act(async () => button('Create')!.click());
  expect(Alert.alert).toHaveBeenLastCalledWith('Check automation details', 'Choose a valid time zone, such as America/Los_Angeles.');
  expect(input('Name').value).toBe('Brief');
  expect(fixture.write).not.toHaveBeenCalled();
});
