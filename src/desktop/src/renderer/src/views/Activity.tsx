import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Select } from "../controls";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { describeAllowed } from "@companybot/core/action-words";
import { agentOptions } from "../agent-options";
import { api } from "../api";
import { usePaginatedQuery, useQuery } from "../convex";
import { navigate } from "../router";
import { HistoryIcon } from "../icons";
import { EmptyState, LoadMore, Loading, NoMatches, Section, cardClass, descriptionClass, metadataClass, timeAgo } from "../ui";
import { actionLabels, valueText, whoLabel } from "./records/logic";

type ActivityEntry = FunctionReturnType<typeof api.activity.forReply>[number];

/** Every tool call agents made in chats you can see. Results show only for calls made for you. */
export function ActivityTab() {
	const agents = useQuery(api.agents.list);
	const database = usePaginatedQuery(api.records.activity, {}, { initialNumItems: 20 });
	const [agentId, setAgentId] = useState<Id<"agents">>();
	const [changesOnly, setChangesOnly] = useState(true);
	const entries = useQuery(api.activity.list, { agentId });
	if (!entries || !agents) return <Loading />;
	const shown = changesOnly ? entries.filter((e) => e.changes) : entries;

	return (
		<>
			{(database.results.length > 0 || database.status !== "Exhausted") && <DatabaseActivity {...database} />}
			<div className="flex items-center gap-4 text-sm">
				<Select
					label="Agent"
					value={agentId ?? ""}
					options={[{ value: "", label: "All agents" }, ...agentOptions(agents)]}
					onChange={(id) => setAgentId((id || undefined) as Id<"agents"> | undefined)}
				/>
				<label className="flex items-center gap-2 text-neutral-600">
					<input type="checkbox" checked={changesOnly} onChange={(e) => setChangesOnly(e.target.checked)} />
					Changes only
				</label>
			</div>
			{shown.length === 0 && database.status !== "LoadingFirstPage" && (agentId || entries.length > 0 ? <NoMatches /> : <EmptyState icon={<HistoryIcon />} title={database.results.length ? "No agent activity yet" : "No activity yet"}>Database changes and agent actions will appear here.</EmptyState>)}
			<div className="flex shrink-0 flex-col gap-2 empty:hidden">
				{shown.map((e) => (
					<ActivityRow key={e._id} entry={e} />
				))}
			</div>
		</>
	);
}

function DatabaseActivity({ results, status, loadMore }: { results: FunctionReturnType<typeof api.records.activity>["page"]; status: string; loadMore: (count: number) => void }) {
	return (
		<Section title="Database changes" hint="Records, fields, databases and shared views, including changes made by agents.">
			{results.map((e) => {
				const [kind, action] = e.action.includes(".") ? e.action.split(".") : ["record", e.action];
				return <div key={e._id} className={`flex flex-col gap-1 text-sm ${cardClass}`}>
					<div className="flex items-baseline gap-2">
						<span className="font-medium">{e.undoes ? "Undid a change to" : actionLabels[action!] ?? action} {kind}: {e.subject ?? e.record ?? e.field ?? e.type}</span>
						<span className={`ml-auto shrink-0 ${metadataClass}`}>{timeAgo(e.time)}</span>
					</div>
					<p className={descriptionClass}>By {whoLabel(e)}</p>
					{e.changes.map((c) => <p key={c.key} className="break-words text-neutral-600">{c.label}: {valueText(undefined, c.old, e.refs) || "empty"} → {valueText(undefined, c.new, e.refs) || "empty"}</p>)}
				</div>;
			})}
			<LoadMore status={status} onMore={() => loadMore(20)} />
		</Section>
	);
}

function ActivityRow({ entry }: { entry: ActivityEntry & { chat: string } }) {
	const [open, setOpen] = useState(false);
	return (
		<div className={`flex flex-col gap-2 text-sm ${cardClass}`}>
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
