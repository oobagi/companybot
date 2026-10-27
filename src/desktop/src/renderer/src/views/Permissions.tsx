import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../api";
import { useAction, useMutation, useQuery } from "../convex";
import { Loading, Notice, Section, Setting, Settings, compactControlClass, metadataClass, secondaryButton, useRun } from "../ui";
import { Confirm } from "./chat/common";

// What agents may do without asking: your own Always / Never per action (Your preferences,
// and each connector's page), owners' workspace locks, and runtime automation approvals. The rules themselves live in the backend (permissions.ts) and apply from
// the next call.

type Action = FunctionReturnType<typeof api.permissions.actions>[number];

const actionName = (a: { label: string; service: string | null }) => `${a.service ? `${a.service} · ` : ""}${a.label}`;

/** Settings → Your preferences: everything you set to Always or Never, and what you allowed for automations. */
export function YourPermissions() {
	const rules = useQuery(api.permissions.mine);
	const set = useMutation(api.permissions.set);
	const remove = useMutation(api.permissions.remove);
	const { error, run } = useRun();
	if (!rules) return <Loading />;
	return (
		<Section
			title="Permissions"
			hint="Agents ask before anything that leaves Companybot: sends, calls, payments, changes in other apps. These are the actions you've set to run without asking, or never."
		>
			{error && <Notice>{error}</Notice>}
			{rules.length === 0 && <p className="text-sm text-neutral-400">Nothing yet. Everything asks first.</p>}
			{rules.map((r) => (
				<div key={r._id} className="flex items-start gap-3 rounded-xl border border-neutral-200 px-4 py-3 text-sm">
					<div className="min-w-0 flex-1">
						<p className="font-medium">
							{actionName(r)}
							{r.automation && <span className="font-normal text-neutral-500"> · for {r.automation.name}</span>}
						</p>
						<p className="text-neutral-500">{r.text}</p>
					</div>
					{r.automation ? (
						<button type="button" onClick={() => run(remove({ ruleId: r._id }))} className="text-neutral-500 hover:text-red-600">
							Remove
						</button>
					) : (
						<select
							aria-label="Setting"
							className={compactControlClass}
							value={r.setting}
							onChange={(e) => run(set({ action: r.action, setting: e.target.value as "ask" | "always" | "never" }))}
						>
							<option value="ask">Ask</option>
							<option value="always">Always</option>
							<option value="never">Never</option>
						</select>
					)}
				</div>
			))}
		</Section>
	);
}

/** Ask / Always / Never for one action. Always isn't offered where it always asks, and nothing where an owner blocked it (its note says so). */
function SettingSelect({ action: a }: { action: Action }) {
	const set = useMutation(api.permissions.set);
	const { error, run } = useRun();
	if (a.lock === "block") return null;
	return (
		<div className="flex flex-col items-end gap-1">
			<select
				aria-label={`${a.label} setting`}
				className={compactControlClass}
				value={a.setting}
				onChange={(e) => run(set({ action: a.action, setting: e.target.value as "ask" | "always" | "never" }))}
			>
				<option value="ask">{a.risk === "none" || a.risk === "inside" ? "Allowed" : "Ask"}</option>
				{(a.canAlways || a.setting === "always") && <option value="always">Always</option>}
				<option value="never">Never</option>
			</select>
			{error && <span className="text-xs text-red-700">{error}</span>}
		</div>
	);
}

const lockNote = (a: Action) => {
	if (a.result === "deny") return a.lock === "block" ? "Blocked by an owner." : "Never: agents can't do this for you.";
	if (a.result === "ask") return a.canAlways ? "Asks first." : "Always asks (locked).";
	if (a.risk === "none") return "Only reads. Runs without asking.";
	if (a.risk === "inside") return "Runs in your chats. Automations following others’ words ask first.";
	return a.alwaysText;
};

/** A connector's actions, each set to Ask / Always / Never for you (the same rules as Your preferences). */
export function ConnectorActions({ connectorId, connected }: { connectorId: string; connected: boolean }) {
	const actions = useQuery(api.permissions.actions, { connectorId });
	const refresh = useAction(api.agent.refreshTools);
	const { error, busy, run } = useRun();
	if (!actions) return <Loading />;
	return (
		<Section title="Actions" hint="What agents can do here when acting for you. Anything that changes something asks first unless you say otherwise.">
			{error && <Notice>{error}</Notice>}
			{actions.length === 0 && (
				<p className="text-sm text-neutral-400">
					{connected ? "Not listed yet." : "Connect it to see what agents can do."}
				</p>
			)}
			{actions.map((a) => (
				<div key={a.action} className="flex items-start gap-3 rounded-xl border border-neutral-200 px-4 py-3 text-sm">
					<div className="min-w-0 flex-1">
						<p className="font-medium">{a.label}</p>
						<p className="line-clamp-2 text-neutral-500">{a.description}</p>
						<p className={`mt-1 ${metadataClass}`}>{lockNote(a)}</p>
					</div>
					<SettingSelect action={a} />
				</div>
			))}
			{connected && (
				<button
					type="button"
					disabled={busy}
					className={`${secondaryButton} self-start`}
					onClick={() => run(refresh({ connectorId }))}
				>
					{busy ? "Checking…" : "Refresh list"}
				</button>
			)}
		</Section>
	);
}

/** Owners: lock actions for everyone. Payments, deletes and bulk sends start locked. */
export function WorkspaceLocks() {
	const actions = useQuery(api.permissions.actions, {});
	const setLock = useMutation(api.permissions.setLock);
	const { error, run } = useRun();
	if (!actions) return <Loading />;
	const shown = actions.filter((a) => a.risk !== "none" || a.lock);
	return (
		<Settings
			title="Action locks"
			hint="For everyone, over anyone's own settings. Locked actions always ask; nobody can set them to Always."
		>
			{error && <div className="p-3"><Notice>{error}</Notice></div>}
			{shown.length === 0 && <p className="px-4 py-3 text-sm text-neutral-400">No actions yet. Install and connect a connector first.</p>}
			{shown.map((a) => {
				const lockedByDefault = a.risk === "locked";
				const value = a.lock ?? "default";
				return (
					<Setting key={a.action} label={actionName(a)}>
						<select
							aria-label={`${a.label} lock`}
							className={`${compactControlClass} w-44`}
							value={value}
							onChange={(e) => {
								const v = e.target.value;
								run(setLock({ action: a.action, lock: v === "default" ? null : (v as "ask" | "block" | "none") }));
							}}
						>
							<option value="default">{lockedByDefault ? "Locked (default)" : "No lock (default)"}</option>
							{lockedByDefault && <option value="none">Unlocked</option>}
							{!lockedByDefault && <option value="ask">Always ask</option>}
							<option value="block">Blocked</option>
						</select>
					</Setting>
				);
			})}
		</Settings>
	);
}

/** Turn-on confirms intent; consent is requested for the exact action when used. */
export function useTurnOn(name: string, turnOn: () => Promise<unknown>) {
	const [pending, setPending] = useState<(() => Promise<unknown>) | null>(null);
	return {
		start: (then = turnOn) => setPending(() => then),
		dialog: pending ? <TurnOnDialog name={name} turnOn={pending} onClose={() => setPending(null)} /> : null,
	};
}

function TurnOnDialog({ name, turnOn, onClose }: { name: string; turnOn: () => Promise<unknown>; onClose: () => void }) {
	const { error, run } = useRun();
	return (
		<Confirm title={`Turn on ${name}?`} action="Turn on" error={error} onConfirm={() => run(turnOn(), onClose)} onClose={onClose}>
			It runs as you. When it needs permission to do something, like post or read your DMs, it'll ask you in your DM with the agent.
			Choose “Always for this automation” there to allow that action on later runs.
		</Confirm>
	);
}
