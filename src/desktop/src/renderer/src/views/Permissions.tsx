import type { FunctionReturnType } from "convex/server";
import { Select } from "../controls";
import { useState } from "react";
import { api } from "../api";
import { useAction, useMutation, useQuery } from "../convex";
import { Loading, Notice, Section, Setting, Settings, cardClass, hintClass, metadataClass, secondaryButton, useRun, wideControlClass } from "../ui";
import { Confirm, useConfirm } from "./chat/common";

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
	const { confirm, dialog } = useConfirm();
	const { error, run } = useRun();
	if (!rules) return <Loading />;
	return (
		<Section
			title="Yours"
			hint="Actions you've set to run without asking, or never, in this workspace."
		>
			{dialog}
			<Notice>{error}</Notice>
			{rules.length === 0 && <p className={hintClass}>Nothing yet. Everything asks first.</p>}
			{rules.map((r) => (
				<div key={r._id} className={`flex items-start gap-3 text-sm ${cardClass}`}>
					<div className="min-w-0 flex-1">
						<p className="font-medium">
							{actionName(r)}
							{r.automation && <span className="font-normal text-neutral-500"> · for {r.automation.name}</span>}
						</p>
						<p className="text-neutral-500">{r.text}</p>
					</div>
					{r.automation ? (
						<button type="button" onClick={() => confirm({ title: "Remove this permission?", action: "Remove permission", danger: false, body: "The automation will ask again before this action runs.", onConfirm: () => remove({ ruleId: r._id }) })} className="text-neutral-500 hover:text-red-600">
							Remove
						</button>
					) : (
						<Select
							label="Setting"
							value={r.setting}
							options={[
								{ value: "ask", label: "Ask" },
								{ value: "always", label: "Always" },
								{ value: "never", label: "Never" },
							]}
							onChange={(setting) => run(set({ action: r.action, setting }))}
						/>
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
			<Select
				label={`${a.label} setting`}
				value={a.setting}
				options={[
					{ value: "ask", label: a.risk === "none" || a.risk === "inside" ? "Allowed" : "Ask" },
					...(a.canAlways || a.setting === "always" ? [{ value: "always" as const, label: "Always" }] : []),
					{ value: "never", label: "Never" },
				]}
				onChange={(setting) => run(set({ action: a.action, setting }))}
			/>
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
			<Notice>{error}</Notice>
			{actions.length === 0 && (
				<p className={hintClass}>
					{connected ? "Not listed yet." : "Connect it to see what agents can do."}
				</p>
			)}
			{actions.map((a) => (
				<div key={a.action} className={`flex items-start gap-3 text-sm ${cardClass}`}>
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
						<Select
							label={`${a.label} lock`}
							className={wideControlClass}
							value={value}
							options={[
								{ value: "default", label: lockedByDefault ? "Locked (default)" : "No lock (default)" },
								...(lockedByDefault ? [{ value: "none" as const, label: "Unlocked" }] : [{ value: "ask" as const, label: "Always ask" }]),
								{ value: "block", label: "Blocked" },
							]}
							onChange={(v) => run(setLock({ action: a.action, lock: v === "default" ? null : v }))}
						/>
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
