import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../api";
import { useAction, useMutation, useQuery } from "../convex";
import { Loading, Notice, Section, compactControlClass, metadataClass, primaryButton, secondaryButton, useRun } from "../ui";
import { insideText } from "@companybot/core/action-words";
import { Modal } from "./chat/common";

// What agents may do without asking: your own Always / Never per action (Your preferences,
// and each connector's page), owners' workspace locks, and asking once when an automation
// is turned on. The rules themselves live in the backend (permissions.ts) and apply from
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
				<option value="ask">{a.risk === "none" ? "Allowed" : "Ask"}</option>
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
	return a.alwaysText;
};

/** A connector's actions, each set to Ask / Always / Never for you (the same rules as Your preferences). */
export function ConnectorActions({ connectorId, connected }: { connectorId: string; connected: boolean }) {
	const actions = useQuery(api.permissions.actions, { connectorId });
	const refresh = useAction(api.agent.refreshTools);
	const { error, run } = useRun();
	const [busy, setBusy] = useState(false);
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
					onClick={() => {
						setBusy(true);
						run(refresh({ connectorId })).finally(() => setBusy(false));
					}}
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
		<Section
			title="Action locks"
			hint="Applies to everyone and beats anyone's own settings. Locked actions ask every time; nobody can set them to Always."
		>
			{error && <Notice>{error}</Notice>}
			{shown.length === 0 && <p className="text-sm text-neutral-400">No actions yet. Install and connect a connector first.</p>}
			{shown.map((a) => {
				const lockedByDefault = a.risk === "locked";
				const value = a.lock ?? "default";
				return (
					<div key={a.action} className="flex items-center gap-3 rounded-xl border border-neutral-200 px-4 py-2 text-sm">
						<span className="min-w-0 flex-1 truncate">{actionName(a)}</span>
						<select
							aria-label={`${a.label} lock`}
							className={compactControlClass}
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
					</div>
				);
			})}
		</Section>
	);
}

/**
 * Turning an automation on, for you: lists what it will do that would ask, and asks once,
 * like a phone asking for an app's permissions. Allow saves Always for those actions, for this
 * automation only; "Ask each time" turns it on anyway, and each one asks in your chat when used.
 * If nothing would ask, it turns on without the screen. `start(turnOn)` overrides what turning on does.
 */
export function useTurnOn(automationId: string, name: string, turnOn: () => Promise<unknown>) {
	const actions = useQuery(api.permissions.forAutomation, { automationId });
	const [pending, setPending] = useState<(() => Promise<unknown>) | null>(null);
	const askable = actions?.filter((a) => a.state === "ask" && !a.allowed) ?? [];
	return {
		start: (then = turnOn) => (askable.length > 0 || actions?.some((a) => a.state === "locked") ? setPending(() => then) : then()),
		dialog:
			pending && actions ? (
				<TurnOnDialog automationId={automationId} name={name} actions={actions} turnOn={pending} onClose={() => setPending(null)} />
			) : null,
	};
}

function TurnOnDialog({
	automationId,
	name,
	actions,
	turnOn,
	onClose,
}: {
	automationId: string;
	name: string;
	actions: FunctionReturnType<typeof api.permissions.forAutomation>;
	turnOn: () => Promise<unknown>;
	onClose: () => void;
}) {
	const allow = useMutation(api.permissions.allowForAutomation);
	const { error, run } = useRun();
	const state = {
		ask: "Runs without asking you, for this automation only.",
		locked: "Still asks you each time (locked).",
		always: "Already set to Always.",
		blocked: "Blocked. It won't run.",
	};
	// Acting as you, one line per area; outside actions one by one, as before.
	const inside = [...new Set(actions.filter((a) => a.inside && a.state === "ask").map((a) => insideText(a.action)))];
	const outside = actions.filter((a) => !a.inside);
	return (
		<Modal title={`Turn on ${name}?`} onClose={onClose}>
			<div className="flex flex-col gap-4 text-sm">
				{inside.length > 0 && (
					<div className="flex flex-col gap-2">
						<p className="text-neutral-600">
							It runs as you, but someone else wrote or changed it, or it acts on data sent in from outside. Allow it to:
						</p>
						<ul className="flex flex-col gap-1 rounded-xl border border-neutral-200 px-3 py-2">
							{inside.map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
					</div>
				)}
				{outside.length > 0 && (
					<div className="flex flex-col gap-2">
						<p className="text-neutral-600">{inside.length ? "It may also do these, which ask first even in your own chats:" : "When it runs for you, it may do these. Allow them now so it doesn't stop to ask:"}</p>
						<ul className="flex flex-col gap-2">
							{outside.map((a) => (
								<li key={a.action} className="rounded-xl border border-neutral-200 px-3 py-2">
									<p className="font-medium">{actionName(a)}</p>
									<p className="text-neutral-500">{a.state === "ask" ? a.alwaysText : state[a.state]}</p>
								</li>
							))}
						</ul>
					</div>
				)}
				<p className="text-xs text-neutral-500">
					Allowed for this automation only. Anything else it tries waits for you in your chat with the agent, and the rest of the run goes on. Change these anytime in
					Settings → Your preferences.
				</p>
				{error && <Notice>{error}</Notice>}
				<div className="flex justify-end gap-2">
					<button type="button" onClick={onClose} className={secondaryButton}>
						Cancel
					</button>
					<button type="button" onClick={() => run(turnOn(), onClose)} className={secondaryButton}>
						Ask each time
					</button>
					<button
						type="button"
						className={primaryButton}
						onClick={() => run(allow({ automationId, actions: actions.map((a) => a.action) }).then(turnOn), onClose)}
					>
						Allow
					</button>
				</div>
			</div>
		</Modal>
	);
}

/** On an automation's page: what you've allowed it to do without asking, and a way to allow the rest. */
export function AutomationPermissions({ automationId, name }: { automationId: string; name: string }) {
	const actions = useQuery(api.permissions.forAutomation, { automationId });
	const review = useTurnOn(automationId, name, async () => {});
	if (!actions || actions.length === 0) return null;
	const allowed = actions.filter((a) => a.allowed).map(actionName);
	const pending = actions.some((a) => a.state === "ask" && !a.allowed);
	return (
		<div className="flex items-center gap-2">
			<span className="w-20 shrink-0 text-neutral-500">Allowed</span>
			<span className="min-w-0 flex-1 text-neutral-600">
				{allowed.length ? `Runs without asking: ${allowed.join(", ")}` : "Asks before acting for you"}
			</span>
			{pending && (
				<button type="button" onClick={() => void review.start()} className="text-neutral-600 hover:text-neutral-900">
					Review
				</button>
			)}
			{review.dialog}
		</div>
	);
}
