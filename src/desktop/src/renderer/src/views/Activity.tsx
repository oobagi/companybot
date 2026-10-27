import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { describeAllowed } from "@companybot/core/action-words";
import { AgentOptions } from "../agent-options";
import { api } from "../api";
import { usePaginatedQuery, useQuery } from "../convex";
import { navigate } from "../router";
import { LoadMore, Loading, Section, compactControlClass, descriptionClass, metadataClass, timeAgo } from "../ui";
import { actionLabels, valueText, whoLabel } from "./records/logic";

export type ActivityEntry = FunctionReturnType<typeof api.activity.forReply>[number];

/** Every tool call agents made in chats you can see. Results show only for calls made for you. */
export function ActivityTab() {
	const agents = useQuery(api.agents.list);
	const [agentId, setAgentId] = useState<Id<"agents">>();
	const [changesOnly, setChangesOnly] = useState(true);
	const entries = useQuery(api.activity.list, { agentId });
	if (!entries || !agents) return <Loading />;
	const shown = changesOnly ? entries.filter((e) => e.changes) : entries;

	return (
		<>
			<DatabaseActivity />
			<p className={descriptionClass}>
				What agents did, in chats you can see. Results show only for what they did for you.
			</p>
			<div className="flex items-center gap-4 text-sm">
				<select
					value={agentId ?? ""}
					onChange={(e) => setAgentId((e.target.value || undefined) as Id<"agents"> | undefined)}
					className={compactControlClass}
				>
					<option value="">All agents</option>
					<AgentOptions agents={agents} />
				</select>
				<label className="flex items-center gap-2 text-neutral-600">
					<input type="checkbox" checked={changesOnly} onChange={(e) => setChangesOnly(e.target.checked)} />
					Changes only
				</label>
			</div>
			{shown.length === 0 && <p className="text-sm text-neutral-400">Nothing yet.</p>}
			<div className="flex flex-col gap-2">
				{shown.map((e) => (
					<ActivityRow key={e._id} entry={e} />
				))}
			</div>
		</>
	);
}

function DatabaseActivity() {
	const { results, status, loadMore } = usePaginatedQuery(api.records.activity, {}, { initialNumItems: 20 });
	return (
		<Section title="Database changes" hint="Records, fields, databases and shared views, including changes made by agents.">
			{results.map((e) => {
				const [kind, action] = e.action.includes(".") ? e.action.split(".") : ["record", e.action];
				return <div key={e._id} className="flex flex-col gap-1 rounded-xl border border-neutral-200 px-4 py-3 text-sm">
					<div className="flex items-baseline gap-2">
						<span className="font-medium">{e.undoes ? "Undid a change to" : actionLabels[action!] ?? action} {kind}: {e.subject ?? e.record ?? e.field ?? e.type}</span>
						<span className={`ml-auto shrink-0 ${metadataClass}`}>{timeAgo(e.time)}</span>
					</div>
					<p className={descriptionClass}>By {whoLabel(e)}</p>
					{e.changes.map((c) => <p key={c.key} className="break-words text-neutral-600">{c.label}: {valueText(undefined, c.old, e.refs) || "empty"} → {valueText(undefined, c.new, e.refs) || "empty"}</p>)}
				</div>;
			})}
			{status === "Exhausted" && !results.length && <p className={descriptionClass}>No changes yet.</p>}
			<LoadMore status={status} onMore={() => loadMore(20)} />
		</Section>
	);
}

function ActivityRow({ entry }: { entry: ActivityEntry & { chat: string } }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex flex-col gap-2 rounded-xl border border-neutral-200 px-4 py-3 text-sm">
			<button type="button" onClick={() => setOpen(!open)} className="flex items-baseline gap-2 text-left">
				<span className="font-medium">{entry.agent}</span>
				<span className="text-neutral-600">{entry.label}</span>
				{entry.status === "error" && <span className="text-xs text-red-600">failed</span>}
				<span className={`ml-auto shrink-0 ${metadataClass}`}>{timeAgo(entry.time)}</span>
			</button>
			<p className="text-xs text-neutral-500">
				For {entry.mine ? "you" : entry.actor} in{" "}
				<button type="button" onClick={() => navigate("chat", entry.chatId)} className="hover:underline">
					{entry.chat}
				</button>
			</p>
			{entry.allowed && <AllowedLine allowed={entry.allowed} mine={entry.mine} />}
			{open && <CallDetails entry={entry} />}
		</div>
	);
}

/**
 * How a call that would have asked was allowed: "Always allowed by Ada, Oct 25", with
 * a link to the rule (in Your preferences) while it still stands.
 */
function AllowedLine({ allowed, mine }: { allowed: NonNullable<ActivityEntry["allowed"]>; mine: boolean }) {
	const text = describeAllowed({ ...allowed, automation: allowed.automation ?? undefined }, allowed.by);
	return (
		<p className="text-xs text-neutral-500">
			{text}
			{allowed.ruleStillOn === false && " · rule since removed"}
			{allowed.ruleStillOn && mine && (
				<>
					{" · "}
					<button type="button" onClick={() => navigate("settings", "preferences")} className="hover:underline">
						See rule
					</button>
				</>
			)}
		</p>
	);
}

/** A call's input, and its result or error. */
export function CallDetails({ entry }: { entry: ActivityEntry }) {
	return (
		<div className="flex flex-col gap-2 text-xs">
			<Block label="Input" text={entry.input} />
			{entry.error !== undefined ? (
				<Block label="Error" text={entry.error} />
			) : entry.output !== undefined ? (
				<Block label="Result" text={entry.output} />
			) : (
				<p className="text-neutral-400">Only {entry.actor} can see the result.</p>
			)}
		</div>
	);
}

function Block({ label, text }: { label: string; text: string }) {
	return (
		<div className="flex flex-col gap-1">
			<span className="text-neutral-500">{label}</span>
			<pre className="max-h-64 overflow-auto rounded-lg bg-neutral-50 px-3 py-2 whitespace-pre-wrap break-words text-neutral-700">
				{text}
			</pre>
		</div>
	);
}
