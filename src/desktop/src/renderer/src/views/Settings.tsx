import type { Role } from "@companybot/core";
import { can } from "@companybot/core/permissions";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache";
import { useState } from "react";
import { api } from "../api";
import { describeUpdate, desktop, useUpdates } from "../desktop";
import {
	ConflictNotice,
	Field,
	Loading,
	Notice,
	Page,
	SaveBar,
	Section,
	Tabs,
	inputClass,
	useRun,
	useDraft,
} from "../ui";
import { ActivityTab } from "./Activity";
import { MembersTab } from "./Members";
import { MemoryTab } from "./Memory";

export const settingsTabs = [
	{ id: "general", label: "General" },
	{ id: "members", label: "Members" },
	{ id: "memory", label: "Memory" },
	{ id: "activity", label: "Activity" },
	{ id: "profile", label: "Your preferences" },
] as const;
export type SettingsTab = (typeof settingsTabs)[number]["id"];

export function SettingsView({ role, tab, onTab }: { role: Role; tab: SettingsTab; onTab: (tab: SettingsTab) => void }) {
	return (
		<Page title="Settings">
			<Tabs tabs={settingsTabs} value={tab} onChange={onTab} />
			{tab === "general" && <GeneralTab role={role} />}
			{tab === "members" && <MembersTab role={role} />}
			{tab === "memory" && <MemoryTab role={role} />}
			{tab === "activity" && <ActivityTab />}
			{tab === "profile" && <ProfileTab />}
		</Page>
	);
}

/** Shared workspace settings: everyone sees them, owners change them. */
function GeneralTab({ role }: { role: Role }) {
	const settings = useQuery(api.workspace.settings);
	if (!settings) return <Loading />;
	return (
		<>
			<GeneralForm settings={settings} isOwner={can(role, "workspace.manage")} />
			<AppVersion />
		</>
	);
}

function AppVersion() {
	const { version, status } = useUpdates();
	if (!desktop) return null;
	return (
		<Section title="App">
			<div className="flex items-center gap-3 rounded-xl border border-neutral-200 px-4 py-3 text-sm">
				<span className="flex-1">
					Companybot {version}
					{status && <span className="block text-neutral-500">{describeUpdate(status)}</span>}
				</span>
				{status?.state === "ready" ? (
					<button type="button" onClick={() => void desktop?.updates.install()} className="font-medium hover:underline">
						Restart
					</button>
				) : (
					<button
						type="button"
						disabled={status?.state === "checking" || status?.state === "downloading"}
						onClick={() => void desktop?.updates.check()}
						className="text-neutral-600 hover:text-neutral-900 disabled:opacity-50"
					>
						Check for updates
					</button>
				)}
			</div>
		</Section>
	);
}

function GeneralForm({ settings, isOwner }: { settings: { name: string; version: number }; isOwner: boolean }) {
	const save = useMutation(api.workspace.updateSettings);
	const draft = useDraft({ name: settings.name }, settings.version);
	const { error, run } = useRun();
	return (
		<>
			{draft.stale && <ConflictNotice onDiscard={draft.discard} onKeep={draft.keepMine} />}
			{error && <Notice>{error}</Notice>}
			<Field label="Workspace name" hint={isOwner ? undefined : "Only owners can change this."}>
				<input
					className={inputClass}
					disabled={!isOwner}
					value={draft.value.name}
					onChange={(e) => draft.set({ name: e.target.value })}
				/>
			</Field>
			{draft.dirty && (
				<SaveBar
					onDiscard={draft.discard}
					onSave={() => run(save({ name: draft.value.name, expectedVersion: draft.base }), draft.discard)}
				/>
			)}
		</>
	);
}

/** Personal: only you see these, and they follow you to every device. */
function ProfileTab() {
	const prefs = useQuery(api.preferences.get);
	const update = useMutation(api.preferences.update);
	const [name, setName] = useState<string>();
	const { error, run } = useRun();
	if (!prefs) return <Loading />;
	const shownName = name ?? prefs.displayName;

	return (
		<>
			<p className="text-sm text-neutral-500">Only you see these. They follow you to every device.</p>
			{error && <Notice>{error}</Notice>}
			<form
				className="flex items-end gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					run(update({ displayName: shownName }), () => setName(undefined));
				}}
			>
				<div className="flex-1">
					<Field label="Your name" hint="What agents and teammates call you.">
						<input className={inputClass} value={shownName} placeholder="e.g. Jaden" onChange={(e) => setName(e.target.value)} />
					</Field>
				</div>
				{name !== undefined && name !== prefs.displayName && (
					<button type="submit" className="mb-6 rounded-xl bg-neutral-900 px-4 py-2 text-sm text-white">
						Save
					</button>
				)}
			</form>
			<Section title="Send messages with">
				{(
					[
						["enter", "Enter", "Shift+Enter adds a new line."],
						["mod-enter", "⌘ Enter", "Enter adds a new line."],
					] as const
				).map(([value, label, hint]) => (
					<label key={value} className="flex items-center gap-3 text-sm">
						<input
							type="radio"
							name="sendWith"
							checked={prefs.sendWith === value}
							onChange={() => run(update({ sendWith: value }))}
						/>
						<span>
							{label} <span className="text-neutral-500">— {hint}</span>
						</span>
					</label>
				))}
			</Section>
		</>
	);
}
