import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex-helpers/react/cache";
import { useState } from "react";
import { describeAllowed } from "@companybot/core/approvals";
import { api } from "../api";
import { navigate } from "../router";
import { Loading, timeAgo } from "../ui";

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
			<p className="text-sm text-neutral-500">
				What agents did, in chats you can see. Results show only for what they did for you.
			</p>
			<div className="flex items-center gap-4 text-sm">
				<select
					value={agentId ?? ""}
					onChange={(e) => setAgentId((e.target.value || undefined) as Id<"agents"> | undefined)}
					className="rounded-lg border border-neutral-200 px-2 py-1"
				>
					<option value="">All agents</option>
					{agents.map((a) => (
						<option key={a._id} value={a._id}>
							{a.archived ? `${a.name} (archived)` : a.name}
						</option>
					))}
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

function ActivityRow({ entry }: { entry: ActivityEntry & { chat: string } }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex flex-col gap-2 rounded-xl border border-neutral-200 px-4 py-3 text-sm">
			<button type="button" onClick={() => setOpen(!open)} className="flex items-baseline gap-2 text-left">
				<span className="font-medium">{entry.agent}</span>
				<span className="text-neutral-600">{entry.label}</span>
				{entry.status === "error" && <span className="text-xs text-red-600">failed</span>}
				<span className="ml-auto shrink-0 text-xs text-neutral-400">{timeAgo(entry.time)}</span>
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
