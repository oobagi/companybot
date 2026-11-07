import { threadWindows } from "@companybot/core/chat";
import { pictureLimits } from "@companybot/core/images";
import { type ImageModelInfo, type ModelInfo, defaultImageModel, imageModelNote, modelNote } from "@companybot/core/models";
import { ROUTER_MODEL, isDecisionModel } from "@companybot/core/router";
import { type Access, can } from "@companybot/core/permissions";
import { formatUsd, monthLabel, usageMonth } from "@companybot/core/usage";
import { useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { describeUpdate, desktop, useUpdates } from "../desktop";
import { navigate } from "../router";
import { ConflictNotice, Form, Loading, Notice, Page, SaveBar, Setting, Settings, actionButton, actionPrimaryButton, dangerButton, disabledButtonClass, hintClass, insetClass, secondaryButton, useDraft, useRun, versionOf, wideControlClass } from "../ui";
import { ActivityIcon, MembersIcon, MemoryIcon, PermissionsIcon, RolesIcon, SettingsIcon, ArchiveIcon, UsageIcon, UserIcon } from "../icons";
import { CurrencySelect, Select, Toggle } from "../controls";
import { ActivityTab } from "./Activity";
import { ImagePicker } from "./ImagePicker";
import { ModelPicker } from "./ModelPicker";
import { Confirm, DialogButtons, Modal, deviceTimeZone, zoneLabel } from "./chat/common";
import { Group, Item } from "./chat/Sidebar";
import { type CustomizeTab, CustomizeView, customizeTabs } from "./customize";
import { MembersTab, RoleScreen, RolesTab } from "./Members";
import { MemoryTab } from "./Memory";
import { WorkspaceLocks, YourPermissions } from "./Permissions";
import { TrashView } from "./Trash";
import { UsageTab } from "./Usage";

// Settings: /settings/<tab>[/<item>]. While it's open, the sidebar lists its tabs in place of the app's.
// Two kinds, opened from different menus and never listed together: your account (your avatar, at
// the bottom of the rail) and the open workspace (the workspace switcher, in the title bar).
// Customize's tabs keep their /settings/<tab> addresses but open from the rail (Customize),
// so Settings' sidebar doesn't list them (`inRail`).
const sections = [
	{ title: "Account", scope: "account", tabs: [{ id: "preferences", label: "Your preferences", icon: <UserIcon /> }] },
	{
		title: "Workspace",
		scope: "workspace",
		tabs: [
			{ id: "general", label: "General", icon: <SettingsIcon /> },
			{ id: "members", label: "Members", description: "People in this workspace", icon: <MembersIcon /> },
			{ id: "roles", label: "Roles", description: "What each role can do", icon: <RolesIcon /> },
			{ id: "permissions", label: "Permissions", description: "What agents ask before doing", icon: <PermissionsIcon /> },
			{ id: "memory", label: "Memory", description: "What agents remember", icon: <MemoryIcon /> },
			{ id: "activity", label: "Activity", description: "What changed, and what agents did", icon: <ActivityIcon /> },
			{ id: "usage", label: "Usage", description: "What AI cost this month", icon: <UsageIcon /> },
			{ id: "archive", label: "Archive", icon: <ArchiveIcon /> },
		],
	},
	{
		title: "Customize",
		scope: "workspace",
		inRail: true,
		tabs: customizeTabs.map((t) => ({ id: t.id, label: t.label, icon: <t.icon /> })),
	},
] as const;
export const settingsTabs = sections.flatMap((s): readonly (typeof s.tabs)[number][] => s.tabs);
type SettingsTab = (typeof settingsTabs)[number]["id"];

/** Whether a tab is your account's or the workspace's. */
export const settingsScope = (tab: SettingsTab) => sections.find((s) => s.tabs.some((t) => t.id === tab))!.scope;

/**
 * Other paths that open a tab: the old "profile". Old /customize/<tab> and /trash paths are
 * redirected in App.
 */
export const settingsTabAliases: Record<string, SettingsTab> = { profile: "preferences", trash: "archive" };

export const isCustomize = (tab: SettingsTab): tab is CustomizeTab => customizeTabs.some((t) => t.id === tab);

/** A tab's screen, or with `itemId`, one agent, connector, skill or automation. */
export function SettingsView({ access, tab, itemId }: { access: Access; tab: SettingsTab; itemId?: string }) {
	if (isCustomize(tab)) return <CustomizeView access={access} tab={tab} itemId={itemId} />;
	if (tab === "archive") return <TrashView access={access} />;
	if (tab === "roles" && itemId) return <RoleScreen access={access} roleId={itemId} />;
	const current = settingsTabs.find((t) => t.id === tab)!;
	return (
		<Page title={current.label} description={(current as { description?: string }).description}>
			{tab === "general" && <GeneralTab access={access} />}
			{tab === "members" && <MembersTab access={access} />}
			{tab === "roles" && <RolesTab access={access} />}
			{tab === "memory" && <MemoryTab access={access} />}
			{tab === "activity" && <ActivityTab />}
			{tab === "usage" && <UsageTab />}
			{tab === "permissions" && (
				<>
					<YourPermissions />
					{can(access, "actions.lock") && <WorkspaceLocks />}
				</>
			)}
			{tab === "preferences" && <ProfileTab />}
		</Page>
	);
}

/** The sidebar while Settings is open: the open tab's kind (account or workspace), by section. */
export function SettingsNav({ tab }: { tab: SettingsTab }) {
	const scope = settingsScope(tab);
	return (
		<>
			{sections.filter((s) => s.scope === scope && !("inRail" in s)).map((s) => (
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

/** Shared workspace settings: everyone sees them; roles with workspace.manage change them. */
function GeneralTab({ access }: { access: Access }) {
	const settings = useQuery(api.workspace.settings);
	const remove = useMutation(api.workspace.deleteWorkspace);
	const reset = useMutation(api.workspace.resetWorkspace);
	if (!settings) return <Loading />;
	const { lastReset } = settings;
	return (
		<>
			<GeneralForm settings={settings} canManage={can(access, "workspace.manage")} />
			{(can(access, "workspace.reset") || can(access, "workspace.delete")) && (
				<Settings title="Danger zone">
					{can(access, "workspace.reset") && (
						<DangerAction
							action="Reset workspace"
							pending="Resetting…"
							hint={`Puts this workspace back to how it was when it was made. Members and roles stay.${lastReset ? ` Last reset by ${lastReset.by} on ${new Date(lastReset.at).toLocaleDateString()}.` : ""}`}
							confirm={settings.name}
							// Everyone's app waits while it resets, then opens #general (App).
							onConfirm={(name) => reset({ name }).then(() => navigate("chat"))}
						>
							Permanently deletes every message, chat, memory, database, page and automation in this workspace, and puts back the
							starting agents and channels. Members and their roles stay. This can't be undone.
						</DangerAction>
					)}
					{can(access, "workspace.delete") && (
						<DangerAction
							action="Delete workspace"
							hint="Deletes this workspace and everything in it, for everyone."
							confirm={settings.name}
							onConfirm={(name) => remove({ name }).then(() => navigate("chat"))}
						>
							Everyone in {settings.name} loses access at once, and its chats, records, agents, memory and connections are deleted. This
							can't be undone.
						</DangerAction>
					)}
				</Settings>
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
					<button type="button" onClick={() => void desktop?.updates.install()} className={actionPrimaryButton}>
						Restart to update
					</button>
				) : (
					<button
						type="button"
						disabled={status?.state === "checking" || status?.state === "downloading"}
						onClick={() => void desktop?.updates.check()}
						className={actionButton}
					>
						Check for updates
					</button>
				)}
			</Setting>
		</Settings>
	);
}

/** A danger zone's row: does something that can't be undone, once you've typed `confirm` (its name, or your email). */
function DangerAction({
	action,
	pending = "Deleting…",
	hint,
	confirm,
	ignoreCase = false,
	onConfirm,
	children,
}: {
	action: string;
	/** The button while it runs. */
	pending?: string;
	hint: string;
	confirm: string;
	ignoreCase?: boolean;
	onConfirm: (typed: string) => Promise<unknown>;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const { error, busy, run } = useRun();
	const matches = ignoreCase ? typed.trim().toLowerCase() === confirm.toLowerCase() : typed.trim() === confirm;
	const close = () => !busy && (setOpen(false), setTyped(""));
	return (
		<>
			<Setting label={action} hint={hint}>
				<button type="button" onClick={() => setOpen(true)} className={`${actionButton} text-red-600`}>
					{action}
				</button>
			</Setting>
			{open && (
				<Modal title={`${action}?`} onClose={close}>
					<Form
						className="flex flex-col gap-4 text-sm"
						onSubmit={() => {
							if (busy || !matches) return;
							run(onConfirm(typed.trim()));
						}}
					>
						<p className="text-neutral-600">{children}</p>
						<Notice>{error}</Notice>
						<Settings>
							<Setting label={`Type “${confirm}” to confirm`}>
								<input aria-label={`Type “${confirm}” to confirm`} className={wideControlClass} autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
							</Setting>
						</Settings>
						<DialogButtons>
							<button type="button" onClick={close} disabled={busy} className={secondaryButton}>
								Cancel
							</button>
							<button type="submit" disabled={busy || !matches} className={dangerButton}>
								{busy ? pending : action}
							</button>
						</DialogButtons>
					</Form>
				</Modal>
			)}
		</>
	);
}

function GeneralForm({
	settings,
	canManage,
}: {
	settings: {
		name: string;
		currency: string;
		memory: boolean;
		hasAmounts: boolean;
		image: string | null;
		imageModel: string;
		imageModels: ImageModelInfo[];
		imageBudgetUsd: number;
		imageSpentUsd: number | null;
		routerModel: string;
		routerModels: ModelInfo[];
		threadHours: number;
		version: number;
	};
	canManage: boolean;
}) {
	const save = useMutation(api.workspace.updateSettings);
	// The budget is edited as typed; the server checks the number.
	const saved = { name: settings.name, currency: settings.currency, memory: settings.memory, imageModel: settings.imageModel, routerModel: settings.routerModel, imageBudget: String(settings.imageBudgetUsd), threadHours: String(settings.threadHours) };
	const draft = useDraft("settings", saved, settings.version);
	const value = canManage ? draft.value : saved;
	const [confirming, setConfirming] = useState(false);
	const { error, run } = useRun();
	const submit = () => {
		const { imageBudget, threadHours, ...rest } = value;
		run(save({ ...rest, imageBudgetUsd: Number(imageBudget || 0), threadHours: Number(threadHours), expectedVersion: draft.base }), () => (draft.discard(), setConfirming(false)));
	};
	const spent = settings.imageSpentUsd === null ? "" : ` ${formatUsd(settings.imageSpentUsd)} used in ${monthLabel(usageMonth(Date.now()))}.`;
	const currencyChanged = value.currency !== settings.currency;
	const ownerOnly = canManage ? undefined : "Your roles can't change workspace settings.";
	return (
		<>
			{canManage && <ConflictNotice draft={draft} />}
			<Notice>{error}</Notice>
			{ownerOnly && <p className={`${hintClass} ${insetClass}`}>{ownerOnly}</p>}
			<Settings title="Workspace">
				<Setting label="Logo" hint={`Its icon in the workspace rail at the far left. ${pictureLimits}.`}>
					<ImagePicker of="workspace" name={settings.name} image={settings.image} agent disabled={!canManage} />
				</Setting>
				<Setting label="Name">
					<input
						className={wideControlClass}
						disabled={!canManage}
						value={value.name}
						onChange={(e) => draft.set({ ...value, name: e.target.value })}
					/>
				</Setting>
				<Setting label="Currency" hint="For new amounts. Existing amounts keep theirs.">
					<CurrencySelect className={wideControlClass} disabled={!canManage} value={value.currency} onChange={(currency) => draft.set({ ...value, currency })} />
				</Setting>
				<Setting label="Threads in the sidebar" hint="How long a thread stays under its channel after its last reply. It's still there under its message either way.">
					<Select
						className={wideControlClass}
						disabled={!canManage}
						value={value.threadHours}
						options={threadWindows.map((w) => ({ value: String(w.hours), label: w.label }))}
						onChange={(threadHours) => draft.set({ ...value, threadHours })}
					/>
				</Setting>
				<Setting label="Memory" hint="Agents remember what people tell them. Off keeps existing memories for later.">
					<Toggle disabled={!canManage} checked={value.memory} onChange={(memory) => draft.set({ ...value, memory })} />
				</Setting>
			</Settings>
			<Settings title="Agents in channels">
				<Setting label="Reply decisions" hint="Decides when agents reply in channels set to “When relevant”. Jev is fastest and cheapest.">
					<ModelPicker
						models={settings.routerModels}
						defaultModel={ROUTER_MODEL}
						value={value.routerModel}
						note={(m) => (isDecisionModel(m.id) ? "Decision model · about 0.2s a call" : modelNote(m))}
						disabled={!canManage}
						className={wideControlClass}
						onChange={(routerModel) => draft.set({ ...value, routerModel })}
					/>
				</Setting>
			</Settings>
			<Settings title="Pictures">
				<Setting label="Picture model" hint="What agents make and edit pictures with, when asked.">
					<ModelPicker
						models={settings.imageModels}
						defaultModel={defaultImageModel}
						value={value.imageModel}
						note={imageModelNote}
						disabled={!canManage}
						className={wideControlClass}
						onChange={(imageModel) => draft.set({ ...value, imageModel })}
					/>
				</Setting>
				<Setting label="Monthly budget" hint={`What agents may spend on pictures each month, in US dollars. $0 turns pictures off.${spent}`}>
					<input
						className={wideControlClass}
						disabled={!canManage}
						inputMode="decimal"
						value={value.imageBudget}
						onChange={(e) => draft.set({ ...value, imageBudget: e.target.value.replace(/[^\d.]/g, "") })}
					/>
				</Setting>
			</Settings>
			{canManage && <SaveBar dirty={draft.dirty} onDiscard={draft.discard} onSave={() => (currencyChanged && settings.hasAmounts ? setConfirming(true) : submit())} />}
			{canManage && confirming && (
				<Confirm title="Change currency?" action="Change currency" onConfirm={submit} onClose={() => setConfirming(false)}>
					Existing amounts stay in {settings.currency}. New amounts will use {value.currency}.
				</Confirm>
			)}
		</>
	);
}

const timeZones = Intl.supportedValuesOf("timeZone");

/** Personal: only you see these, and they follow you to every device. */
function ProfileTab() {
	const prefs = useQuery(api.preferences.get);
	const update = useMutation(api.preferences.update);
	const me = useQuery(api.workspace.me);
	const erase = useMutation(api.workspace.eraseAccount);
	// Edited together and saved from the top bar, like General. The draft keeps `start`, your preferences
	// as they were when you began, so Save sends only what you changed here, never another device's change
	// back; if they changed meanwhile, Save waits until you pick theirs or yours (ConflictNotice).
	const saved = { displayName: prefs?.displayName ?? "", timeZone: prefs?.timeZone ?? "auto", sendWith: prefs?.sendWith ?? "enter", notify: prefs?.notify ?? "all", showRecents: prefs?.showRecents ?? true };
	const draft = useDraft("account:preferences", { ...saved, start: saved }, versionOf(saved));
	const value = draft.value;
	const { error, run } = useRun();
	if (!prefs) return <Loading />;
	const save = () => {
		const { start } = value;
		const changed = {
			...(value.displayName !== start.displayName && { displayName: value.displayName }),
			...(value.timeZone !== start.timeZone && { timeZone: value.timeZone === "auto" ? null : value.timeZone }),
			...(value.sendWith !== start.sendWith && { sendWith: value.sendWith }),
			...(value.notify !== start.notify && { notify: value.notify }),
			...(value.showRecents !== start.showRecents && { showRecents: value.showRecents }),
		};
		run(update(changed), () => draft.discard());
	};

	return (
		<>
			<SaveBar dirty={draft.dirty} canSave={!draft.stale} onSave={save} onDiscard={draft.discard} />
			<ConflictNotice draft={draft} />
			<Notice>{error}</Notice>
			<Settings title="You" note="Only you see these, except your photo, name and time zone.">
				<Setting label="Photo" hint={`Shown to your team in every workspace. ${pictureLimits}.`}>
					<ImagePicker of="me" name={prefs.displayName || me?.email || ""} image={prefs.image} />
				</Setting>
				<Setting label="Name" hint="What agents and teammates call you.">
					<input className={wideControlClass} value={value.displayName} placeholder="e.g. Jaden" onChange={(e) => draft.set({ ...value, displayName: e.target.value })} />
				</Setting>
				<Setting label="Time zone" hint="For dates and times agents give you.">
					<Select
						className={wideControlClass}
						value={value.timeZone}
						options={[{ value: "auto", label: `Automatic (${zoneLabel(deviceTimeZone())})` }, ...timeZones.map((zone) => ({ value: zone, label: zoneLabel(zone) }))]}
						onChange={(timeZone) => draft.set({ ...value, timeZone })}
					/>
				</Setting>
				<Setting label="Send messages with" hint={value.sendWith === "enter" ? "Shift+Enter adds a new line." : "Enter adds a new line."}>
					<Select
						className={wideControlClass}
						value={value.sendWith}
						options={[
							{ value: "enter", label: "Enter" },
							{ value: "mod-enter", label: "⌘ Enter" },
						]}
						onChange={(sendWith) => draft.set({ ...value, sendWith })}
					/>
				</Setting>
				<Setting label="Notifications" hint="When Companybot isn't in front, and the dock count.">
					<Select
						className={wideControlClass}
						value={value.notify}
						options={[
							{ value: "all", label: "DMs and mentions" },
							{ value: "mentions", label: "Mentions only" },
							{ value: "off", label: "Off" },
						]}
						onChange={(notify) => draft.set({ ...value, notify })}
					/>
				</Setting>
				<Setting label="Recents on the rail" hint="The places you opened lately, under your pins. Right-click the rail to change this too.">
					<Toggle checked={value.showRecents} onChange={(showRecents) => draft.set({ ...value, showRecents })} />
				</Setting>
			</Settings>
			<AppVersion />
			{me && (
				<Settings title="Danger zone">
					<DangerAction
						action="Delete account"
						hint="Deletes your account and takes you out of every workspace."
						confirm={me.email}
						ignoreCase
						onConfirm={() => erase()}
					>
						You'll leave every workspace and be signed out. Workspaces only you are in are deleted with everything in them. Your name,
						preferences and connected accounts are deleted; what you said in shared chats stays, as a former member's. If you're the only
						owner of a workspace with other people in it, make someone else an owner first. This can't be undone.
					</DangerAction>
				</Settings>
			)}
		</>
	);
}
