import type { Role } from "@companybot/core";
import { can } from "@companybot/core/permissions";
import { currencyCodes } from "@companybot/core/records";
import { useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { describeUpdate, desktop, useUpdates } from "../desktop";
import { navigate } from "../router";
import {
	ConflictNotice,
	Field,
	Loading,
	Notice,
	Page,
	SaveBar,
	Setting,
	Settings,
	compactControlClass,
	dangerButton,
	disabledButtonClass,
	inputClass,
	primaryButton,
	secondaryButton,
	useDraft,
	useRun,
} from "../ui";
import {
	ActivityIcon,
	AgentIcon,
	AutomationIcon,
	ConnectorIcon,
	MembersIcon,
	MemoryIcon,
	SettingsIcon,
	SkillIcon,
	TrashIcon,
	UserIcon,
} from "../icons";
import { Select } from "../controls";
import { ActivityTab } from "./Activity";
import { Confirm, Modal, zoneLabel } from "./chat/common";
import { Group, Item } from "./chat/Sidebar";
import { type CustomizeTab, CustomizeView, customizeTabs } from "./customize";
import { MembersTab } from "./Members";
import { MemoryTab } from "./Memory";
import { WorkspaceLocks, YourPermissions } from "./Permissions";
import { TrashView } from "./Trash";

// Settings: /settings/<tab>[/<item>]. While it's open, the sidebar lists its tabs in place of the app's.
const sections = [
	{ title: "Account", tabs: [{ id: "preferences", label: "Your preferences", icon: <UserIcon /> }] },
	{
		title: "Workspace",
		tabs: [
			{ id: "general", label: "General", icon: <SettingsIcon /> },
			{ id: "members", label: "Members", icon: <MembersIcon /> },
			{ id: "memory", label: "Memory", icon: <MemoryIcon /> },
			{ id: "activity", label: "Activity", icon: <ActivityIcon /> },
			{ id: "trash", label: "Trash", icon: <TrashIcon /> },
		],
	},
	{
		title: "Customize",
		tabs: [
			{ id: "agents", label: "Agents", icon: <AgentIcon /> },
			{ id: "connectors", label: "Connectors", icon: <ConnectorIcon /> },
			{ id: "skills", label: "Skills", icon: <SkillIcon /> },
			{ id: "automations", label: "Automations", icon: <AutomationIcon /> },
		],
	},
] as const;
export const settingsTabs = sections.flatMap((s): readonly (typeof s.tabs)[number][] => s.tabs);
export type SettingsTab = (typeof settingsTabs)[number]["id"];

/**
 * Other paths that open a tab: the old "profile", and "permissions" (they're in Your preferences).
 * Old /customize/<tab> and /trash paths are redirected in App.
 */
export const settingsTabAliases: Record<string, SettingsTab> = { profile: "preferences", permissions: "preferences" };

const isCustomize = (tab: SettingsTab): tab is CustomizeTab => customizeTabs.some((t) => t.id === tab);

/** A tab's screen, or with `itemId`, one agent, connector, skill or automation. */
export function SettingsView({ role, tab, itemId }: { role: Role; tab: SettingsTab; itemId?: string }) {
	if (isCustomize(tab)) return <CustomizeView role={role} tab={tab} itemId={itemId} />;
	if (tab === "trash") return <TrashView role={role} />;
	return (
		<Page title={settingsTabs.find((t) => t.id === tab)!.label}>
			{tab === "general" && <GeneralTab role={role} />}
			{tab === "members" && <MembersTab role={role} />}
			{tab === "memory" && <MemoryTab role={role} />}
			{tab === "activity" && <ActivityTab />}
			{tab === "preferences" && <ProfileTab />}
		</Page>
	);
}

/** The sidebar while Settings is open: every tab, by section. */
export function SettingsNav({ tab }: { tab: SettingsTab }) {
	return (
		<>
			{sections.map((s) => (
				<Group key={s.title} title={s.title}>
					{s.tabs.map((t) => (
						<Item key={t.id} icon={t.icon} active={t.id === tab} onClick={() => navigate("settings", t.id)}>
							{t.label}
						</Item>
					))}
				</Group>
			))}
		</>
	);
}

/** Shared workspace settings: everyone sees them, owners change them. */
function GeneralTab({ role }: { role: Role }) {
	const settings = useQuery(api.workspace.settings);
	const remove = useMutation(api.workspace.deleteWorkspace);
	if (!settings) return <Loading />;
	return (
		<>
			<GeneralForm settings={settings} isOwner={can(role, "workspace.manage")} />
			{can(role, "actions.lock") && <WorkspaceLocks />}
			<AppVersion />
			{can(role, "workspace.delete") && (
				<DangerZone
					action="Delete workspace"
					hint="Deletes this workspace and everything in it, for everyone."
					confirm={settings.name}
					onDelete={(name) => remove({ name }).then(() => navigate("chat"))}
				>
					Everyone in {settings.name} loses access at once, and its chats, records, agents, memory and connections are deleted. This
					can't be undone.
				</DangerZone>
			)}
		</>
	);
}

function AppVersion() {
	const { version, status } = useUpdates();
	if (!desktop) return null;
	return (
		<Settings title="App">
			<Setting label={`Companybot ${version}`} hint={status ? describeUpdate(status) : undefined}>
				{status?.state === "ready" ? (
					<button type="button" onClick={() => void desktop?.updates.install()} className={primaryButton}>
						Restart to update
					</button>
				) : (
					<button
						type="button"
						disabled={status?.state === "checking" || status?.state === "downloading"}
						onClick={() => void desktop?.updates.check()}
						className={secondaryButton}
					>
						Check for updates
					</button>
				)}
			</Setting>
		</Settings>
	);
}

/** Deletes something for good, once you've typed `confirm` (its name, or your email). */
function DangerZone({
	action,
	hint,
	confirm,
	ignoreCase = false,
	onDelete,
	children,
}: {
	action: string;
	hint: string;
	confirm: string;
	ignoreCase?: boolean;
	onDelete: (typed: string) => Promise<unknown>;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const { error, busy, run } = useRun();
	const matches = ignoreCase ? typed.trim().toLowerCase() === confirm.toLowerCase() : typed.trim() === confirm;
	const close = () => !busy && (setOpen(false), setTyped(""));
	return (
		<Settings title="Danger zone">
			<Setting label={action} hint={hint}>
				<button type="button" onClick={() => setOpen(true)} className={`${secondaryButton} text-red-600`}>
					{action}
				</button>
			</Setting>
			{open && (
				<Modal title={`${action}?`} onClose={close}>
					<form
						className="flex flex-col gap-4 text-sm"
						onSubmit={(e) => {
							e.preventDefault();
							if (busy || !matches) return;
							run(onDelete(typed.trim()));
						}}
					>
						<p className="text-neutral-600">{children}</p>
						{error && <Notice>{error}</Notice>}
						<Field label={`Type “${confirm}” to confirm`}>
							<input className={inputClass} autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
						</Field>
						<div className="flex justify-end gap-2">
							<button type="button" onClick={close} disabled={busy} className={secondaryButton}>
								Cancel
							</button>
							<button type="submit" disabled={busy || !matches} className={dangerButton}>
								{busy ? "Deleting…" : action}
							</button>
						</div>
					</form>
				</Modal>
			)}
		</Settings>
	);
}

/** An on/off switch. */
function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={`relative h-5 w-9 rounded-full transition-colors ${checked ? "bg-neutral-900" : "bg-neutral-300"} ${disabledButtonClass}`}
		>
			<span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`} />
		</button>
	);
}

const currencyNames = new Intl.DisplayNames(undefined, { type: "currency" });
/** "EUR — Euro", or just the code where the system has no name for it. */
const currencyLabel = (code: string) => {
	const name = currencyNames.of(code);
	return name && name !== code ? `${code} — ${name}` : code;
};

function GeneralForm({
	settings,
	isOwner,
}: {
	settings: { name: string; currency: string; memory: boolean; hasAmounts: boolean; version: number };
	isOwner: boolean;
}) {
	const save = useMutation(api.workspace.updateSettings);
	const draft = useDraft({ name: settings.name, currency: settings.currency, memory: settings.memory }, settings.version);
	const [confirming, setConfirming] = useState(false);
	const { error, run } = useRun();
	const submit = () => run(save({ ...draft.value, expectedVersion: draft.base }), () => (draft.discard(), setConfirming(false)));
	const currencyChanged = draft.value.currency !== settings.currency;
	const ownerOnly = isOwner ? undefined : "Only owners can change this.";
	return (
		<>
			{draft.stale && <ConflictNotice onDiscard={draft.discard} onKeep={draft.keepMine} />}
			{error && <Notice>{error}</Notice>}
			<Settings title="Workspace" hint={ownerOnly}>
				<Setting label="Name">
					<input
						className={`${compactControlClass} w-64`}
						disabled={!isOwner}
						value={draft.value.name}
						onChange={(e) => draft.set({ ...draft.value, name: e.target.value })}
					/>
				</Setting>
				<Setting label="Currency" hint="For new amounts. Existing amounts keep theirs.">
					<Select
						className={`${compactControlClass} w-64`}
						disabled={!isOwner}
						value={draft.value.currency}
						options={currencyCodes.map((code) => ({ value: code, label: currencyLabel(code) }))}
						onChange={(currency) => draft.set({ ...draft.value, currency })}
					/>
				</Setting>
				<Setting label="Memory" hint="Agents remember what people tell them. Off keeps existing memories for later.">
					<Toggle disabled={!isOwner} checked={draft.value.memory} onChange={(memory) => draft.set({ ...draft.value, memory })} />
				</Setting>
			</Settings>
			{draft.dirty && (
				<SaveBar onDiscard={draft.discard} onSave={() => (currencyChanged && settings.hasAmounts ? setConfirming(true) : submit())} />
			)}
			{confirming && (
				<Confirm title="Change currency?" action="Change currency" onConfirm={submit} onClose={() => setConfirming(false)}>
					Existing amounts stay in {settings.currency}. New amounts will use {draft.value.currency}.
				</Confirm>
			)}
		</>
	);
}

const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const timeZones = Intl.supportedValuesOf("timeZone");

/** Personal: only you see these, and they follow you to every device. */
function ProfileTab() {
	const prefs = useQuery(api.preferences.get);
	const update = useMutation(api.preferences.update);
	const me = useQuery(api.workspace.me);
	const erase = useMutation(api.workspace.eraseAccount);
	const [name, setName] = useState<string>();
	const { error, run } = useRun();
	if (!prefs) return <Loading />;
	const shownName = name ?? prefs.displayName;

	return (
		<>
			{error && <Notice>{error}</Notice>}
			<Settings title="You" hint="Only you see these, except your name and time zone. They follow you to every device.">
				<Setting label="Name" hint="What agents and teammates call you.">
					<form
						className="flex gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							run(update({ displayName: shownName }), () => setName(undefined));
						}}
					>
						<input className={`${compactControlClass} w-48`} value={shownName} placeholder="e.g. Jaden" onChange={(e) => setName(e.target.value)} />
						{name !== undefined && name !== prefs.displayName && (
							<button type="submit" className={`${primaryButton} py-1`}>
								Save
							</button>
						)}
					</form>
				</Setting>
				<Setting label="Time zone" hint="For dates and times agents give you.">
					<Select
						className={`${compactControlClass} w-64`}
						value={prefs.timeZone ?? "auto"}
						options={[{ value: "auto", label: `Automatic (${zoneLabel(deviceTimeZone)})` }, ...timeZones.map((zone) => ({ value: zone, label: zoneLabel(zone) }))]}
						onChange={(zone) => run(update({ timeZone: zone === "auto" ? null : zone }))}
					/>
				</Setting>
				<Setting label="Send messages with" hint={prefs.sendWith === "enter" ? "Shift+Enter adds a new line." : "Enter adds a new line."}>
					<Select
						className={`${compactControlClass} w-64`}
						value={prefs.sendWith}
						options={[
							{ value: "enter", label: "Enter" },
							{ value: "mod-enter", label: "⌘ Enter" },
						]}
						onChange={(sendWith) => run(update({ sendWith }))}
					/>
				</Setting>
				<Setting label="Notifications" hint="When Companybot isn't in front, and the dock count.">
					<Select
						className={`${compactControlClass} w-64`}
						value={prefs.notify}
						options={[
							{ value: "all", label: "DMs and mentions" },
							{ value: "mentions", label: "Mentions only" },
							{ value: "off", label: "Off" },
						]}
						onChange={(notify) => run(update({ notify }))}
					/>
				</Setting>
			</Settings>
			<YourPermissions />
			{me && (
				<DangerZone
					action="Delete account"
					hint="Deletes your account and takes you out of every workspace."
					confirm={me.email}
					ignoreCase
					onDelete={() => erase()}
				>
					You'll leave every workspace and be signed out. Workspaces only you are in are deleted with everything in them. Your name,
					preferences and connected accounts are deleted; what you said in shared chats stays, as a former member's. If you're the only
					owner of a workspace with other people in it, make someone else an owner first. This can't be undone.
				</DangerZone>
			)}
		</>
	);
}
